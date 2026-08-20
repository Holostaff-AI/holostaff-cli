// AUTO-SYNCED from holostaff-agent/server/scripts/sim/run.ts — do not edit here.
// Re-sync: bash server/scripts/sim/sync-cli-engine.sh
/**
 * User-simulation P0 runner (documents/prd-user-simulation.md §6 P0).
 *
 * Drives one persona (a sheet in personas/) through one scenario (a sheet
 * in scenarios/) against a locally served target app, browser-only. The
 * loop is the onboarding-bench shopper's proven perceive→decide→act text
 * loop, with three P0 additions:
 *
 *   1. persona-conditioned: the briefing is built from the persona sheet;
 *      patience/expressiveness act as MECHANICAL params the harness
 *      enforces (nudges, wait ceilings), not just prose.
 *   2. every decide step emits "emotion" (validated label) and "say"
 *      (a think-aloud line) — the material for the Rehearsal reaction cam.
 *   3. per-call token usage is captured into cogs.json — the measured
 *      per-run COGS that sets pricing (PRD §10).
 *
 * The whole run is filmed via Playwright recordVideo (1280x720) so event
 * timestamps map 1:1 onto the replay for compositing.
 *
 *   cd server && npx tsx scripts/sim/run.ts \
 *     [--persona maya] [--scenario opnform-first-form] [--max-steps N]
 *
 * NOTE: the target's SDK bot-guard is deliberately NOT bypassed (no
 * __HS_EVAL__): the parked copilot stays silent — this films the persona
 * and the product, nothing else.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { loadPersona, mechanicalParams, personaBriefing, type PersonaSheet } from './personaSheet.js'
import { DIGEST_JS } from './digest.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── config ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const argOf = (flag: string, dflt: string): string => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt
}
const PERSONA_ID = argOf('--persona', 'maya')
const SCENARIO_ID = argOf('--scenario', 'opnform-first-form')
// The persona SEES the page: every decide step carries the current
// screenshot alongside the text digest. gpt-5 (low reasoning effort) is
// the default driver — the text-only gpt-4.1 loop mis-modeled anything
// spatial (modals, hover toolbars, which field is which).
const MODEL = process.env.SIM_MODEL ?? 'gpt-5'
const REASONING = process.env.SIM_REASONING ?? 'low'

// $/1M tokens — cogs ledger. Defaults follow the model; override via env.
const DEFAULT_PRICES: Record<string, [number, number]> = {
  'gpt-5.6-luna': [0.2, 1.2], // post 2026-07-30 cut
  'gpt-5': [1.25, 10.0],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-4.1': [2.0, 8.0],
}
const [dIn, dOut] = DEFAULT_PRICES[MODEL] ?? [2.0, 8.0]
const PRICE_IN = Number(process.env.SIM_PRICE_IN ?? dIn)
const PRICE_OUT = Number(process.env.SIM_PRICE_OUT ?? dOut)

interface Scenario {
  id: string
  target: string
  baseUrl: string
  startPath: string
  context: string
  goal: string
  credentials?: { email: string; password: string }
  /** sanctioned FAKE payment card for demo/test checkouts — without this,
   *  the persona refuses all payment forms (the safe default) */
  testCard?: { number: string; expiry?: string; cvc?: string }
  /** pre-seeded localStorage (dev-auth targets: the identity is set before
   *  first paint, so the persona starts signed in — the scenario context
   *  should say so) */
  initLocalStorage?: Record<string, string>
  maxSteps: number
  wallMin: number
  /** derived-success check (D5): a command printing {"success", "evidence"} */
  verify?: { cmd: string }
  /** 'handover' = Level 2 certification (autopilots PRD §6.2): the persona
   *  hands control to the product's autopilot and plays the human side —
   *  accepts the offer, answers its asks, Allows/Denies its gates, and
   *  judges the outcome. The briefing changes accordingly. */
  mode?: string
}

const SIM_DIR = process.env.SIM_DIR ?? HERE
const persona: PersonaSheet = loadPersona(SIM_DIR, PERSONA_ID)
const scenario = JSON.parse(
  readFileSync(join(SIM_DIR, 'scenarios', `${SCENARIO_ID}.json`), 'utf8'),
) as Scenario
const mech = mechanicalParams(persona)

const MAX_STEPS = Number(argOf('--max-steps', String(scenario.maxSteps)))
const WALL_MS = scenario.wallMin * 60_000

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const OUT = join(process.env.SIM_OUT ?? join(process.cwd(), 'scripts/sim/runs'), runId)
mkdirSync(join(OUT, 'shots'), { recursive: true })

// Model access, in preference order (CI-portable):
//   1. SIM_MODEL_BASE_URL + SIM_MODEL_KEY — any OpenAI-compatible endpoint,
//      including Holostaff's workspace-metered sim proxy in CI;
//   2. OPENAI_API_KEY in the environment;
//   3. OPENAI_API_KEY in ./.env (the box-local dev default).
const MODEL_BASE = (process.env.SIM_MODEL_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '')
const OPENAI_KEY = (process.env.SIM_MODEL_KEY ?? process.env.OPENAI_API_KEY ?? (() => {
  try {
    return /^OPENAI_API_KEY=(.+)$/m.exec(readFileSync(join(process.cwd(), '.env'), 'utf8'))?.[1]?.trim()
  } catch { return undefined }
})()) ?? ''
if (!OPENAI_KEY) { console.error('no model key: set SIM_MODEL_KEY or OPENAI_API_KEY'); process.exit(2) }

const base = new URL(scenario.baseUrl)

// ── event log ─────────────────────────────────────────────────────────────
const EMOTIONS = ['neutral', 'curious', 'focused', 'confused', 'frustrated', 'anxious', 'delighted', 'relieved'] as const
type Emotion = (typeof EMOTIONS)[number]

interface Ev {
  step: number
  /** ms since the video started — event times map onto the replay */
  t: number
  url?: string
  thought: string
  say: string
  emotion: Emotion
  action: string
  detail: string
  ok: boolean
  confusion?: string
  quote?: string
}
const events: Ev[] = []
const cogs = { llmCalls: 0, tokensIn: 0, tokensOut: 0 }
let tV0 = Date.now() // reset when the recorded page opens

// ── browser ───────────────────────────────────────────────────────────────
let browser: Browser | null = null
let page: Page | null = null

async function pageDigest(): Promise<string> {
  if (!page) return '(no page open)'
  const url = page.url()
  const title = await page.title().catch(() => '')
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => { /* */ })
  let digest = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    digest = await digestOnce()
    if (digest.split('\n').length >= 4) break
    await page.waitForTimeout(2_500)
  }
  return `URL: ${url}\nTITLE: ${title}\n${digest}`
}

// Passed to page.evaluate as a STRING: tsx/esbuild injects a `__name` helper
// into nested functions inside evaluate callbacks, which does not exist in
// the browser context (ReferenceError) — a string expression bypasses the
// transform entirely. (Bench digest + one perception fix: when a dialog is
// open on top of the page, a human sees the dimmed overlay and knows only
// the dialog is interactive — so the digest presents ONLY the dialog.
// Without this the persona clicks blocked background buttons and reads the
// harness timeout as product breakage.)
// DIGEST_JS lives in digest.ts (shared with the autopilot harness).

async function digestOnce(): Promise<string> {
  if (!page) return ''
  return page.evaluate(DIGEST_JS).then(v => String(v)).catch(err => `(digest failed: ${(err as Error).message.split('\n')[0]})`)
}

// New tabs break the simulation's single point of view: the recording,
// digest, and cursor all live on ONE page, so a target=_blank link or
// window.open would navigate somewhere the persona can't see (suite
// msxl72mz: "Clicked Open form but nothing opened"). Coerce both into
// same-tab navigation — the persona follows the link.
const SAME_TAB_JS = `(() => {
  if (window.__simSameTab) return
  window.__simSameTab = true
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null
    if (a) a.target = '_self'
  }, true)
  const _open = window.open
  window.open = function (url) {
    if (url) { window.location.href = url; return window }
    return _open.apply(window, arguments)
  }
})()`

// A visible cursor + click ripple, drawn in-page so the recording shows a
// real session, not a ghost-driven one. String for the same esbuild reason
// as DIGEST_JS.
const CURSOR_JS = `(() => {
  if (window.__simCursor) return
  window.__simCursor = true
  const mk = () => {
    if (document.getElementById('__sim_cursor')) return
    const c = document.createElement('div')
    c.id = '__sim_cursor'
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;z-index:2147483647;pointer-events:none'
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L20 12 L12.5 13.5 L9 21 Z" fill="black" stroke="white" stroke-width="1.6"/></svg>'
    document.documentElement.appendChild(c)
    document.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    document.addEventListener('mousedown', e => {
      const r = document.createElement('div')
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;left:' + (e.clientX - 14) + 'px;top:' + (e.clientY - 14) + 'px;width:28px;height:28px;border-radius:50%;border:3px solid #4f8bff;opacity:.9;transform:scale(.4);transition:transform .45s ease-out,opacity .45s ease-out'
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => { r.style.transform = 'scale(1.15)'; r.style.opacity = '0' })
      setTimeout(() => r.remove(), 600)
    }, true)
  }
  if (document.readyState !== 'loading') mk()
  else document.addEventListener('DOMContentLoaded', mk)
})()`

let shot = 0
async function snap(label: string): Promise<void> {
  try { await page?.screenshot({ path: join(OUT, 'shots', `${String(shot++).padStart(3, '0')}-${label.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}.png`) }) } catch { /* */ }
}

// ── briefing ──────────────────────────────────────────────────────────────
const credLines = scenario.credentials
  ? `- Your login is ${scenario.credentials.email} with password ${scenario.credentials.password}.`
  : '- You have no login; use what the product offers.'

const payLine = scenario.testCard
  ? `- This is a TEST checkout: pay with the fake test card ${scenario.testCard.number}, expiry ${scenario.testCard.expiry ?? 'any future date'}, CVC ${scenario.testCard.cvc ?? 'any 3 digits'}. No real money exists here; entering it is safe and expected.`
  : '- You never enter payment details of any kind.'

const handoverLines = scenario.mode === 'handover' ? `

This product has an AUTOPILOT, and today you want it to do the work:
- A small card will offer to do this workflow for you ("Do this for me").
  Accept it. If a box asks what you want, tell it in your own words.
- After you hand over, your job is to WATCH. The autopilot moves the
  cursor and fills things by itself. Do not do the task yourself — use
  "wait" while it visibly works, and react honestly to what you see.
- It may show small cards asking you questions. Answer them in your own
  words.
- A small prompt may ask you to Allow or Deny one of its actions (like
  placing an order). Decide like yourself: if it matches what you asked
  for, Allow. If it worries you, Deny.
- If it asks you to type sensitive fields (like the card number)
  yourself, type them into the page yourself, then press its continue
  button.
- If it says "Paused" because you touched something, press Resume when
  you want it to continue.
- When it says it finished, look at the screen and judge honestly:
  "done" only if your task truly got done; "stuck" if it failed you.` : ''

const BRIEFING = `${personaBriefing(persona, mech)}

Your situation: ${scenario.context}

Your goal: ${scenario.goal}${handoverLines}

Practical facts:
${credLines}
${payLine}
- You never speak passwords, codes, or email addresses out loud in "say".
- If a process is visibly running (spinner, progress), "wait" is fine — but
  waiting on nothing is friction, and your patience is limited.
- If you are truly stuck and out of ideas, use "stuck" (that records that
  you gave up, which is a legitimate ending).
- Before "done", look at the screen honestly: if something is still wrong
  or half-finished, either fix it or SAY SO in your last words. Never
  declare a flawed result perfect.

You interact through numbered steps. Each step you see the current page
digest, then choose ONE action as strict JSON:
{
  "thought": "one sentence of what you believe the next step is and why",
  "say": "what you mutter out loud right now, or \\"\\"",
  "emotion": "neutral|curious|focused|confused|frustrated|anxious|delighted|relieved",
  "confusion": "optional — blunt note when copy/behavior confused or misled you",
  "quote": "optional — the exact on-screen text that misled you",
  "action": one of
    {"type":"goto","path":"/somewhere"}                   // navigate within the app
    {"type":"click","text":"visible label"}               // click button/link by its visible text; buttons listed as (icon: name) are clicked by that name
    {"type":"hover","text":"visible label"}               // rest your mouse on something — apps often reveal controls on hover
    {"type":"fill","target":"placeholder or label text","value":"...","nth":2}  // nth optional: 2 = the second matching box on screen
    {"type":"choose","target":"dropdown label","value":"the option you pick"}   // pick from a dropdown (native or custom)
    {"type":"press","key":"Enter"}
    {"type":"wait","seconds":20,"watching":"what you are waiting on"}
    {"type":"done","summary":"what you achieved end to end"}
    {"type":"stuck","why":"where and why you gave up"}
}
Return ONLY the JSON object.`

interface LlmAction {
  thought: string
  say?: string
  emotion?: string
  confusion?: string
  quote?: string
  action: { type: string; path?: string; text?: string; target?: string; value?: string; nth?: number; key?: string; seconds?: number; watching?: string; summary?: string; why?: string }
}

const history: { role: 'user' | 'assistant'; content: string }[] = []

async function llm(observation: string, screenshotB64?: string): Promise<LlmAction> {
  history.push({ role: 'user', content: observation })
  const window = history.slice(-24)
  // The screenshot rides only on the CURRENT message — history stays
  // text, so the context doesn't balloon with stale images.
  const messages: unknown[] = [{ role: 'system', content: BRIEFING }, ...window.slice(0, -1)]
  messages.push(
    screenshotB64
      ? {
          role: 'user',
          content: [
            { type: 'text', text: observation },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
          ],
        }
      : { role: 'user', content: observation },
  )
  const payload: Record<string, unknown> = {
    model: MODEL,
    response_format: { type: 'json_object' },
    messages,
  }
  if (MODEL.startsWith('gpt-5')) payload.reasoning_effort = REASONING
  else payload.temperature = 0.5
  const res = await fetch(`${MODEL_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json() as {
    choices: { message: { content: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  cogs.llmCalls += 1
  cogs.tokensIn += body.usage?.prompt_tokens ?? 0
  cogs.tokensOut += body.usage?.completion_tokens ?? 0
  const content = body.choices[0]!.message.content
  history.push({ role: 'assistant', content })
  return JSON.parse(content) as LlmAction
}

// ── friction bookkeeping ──────────────────────────────────────────────────
const urlVisits = new Map<string, number>()
let lastDigestHash = ''
let consecNoProgress = 0
const hash = (s: string): string => String([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))

// ── main loop ─────────────────────────────────────────────────────────────
let endState = 'step-cap'
let endDetail = ''
let malformed = 0
const t0 = Date.now()

const main = async (): Promise<void> => {
  console.log(`sim run ${runId} — ${persona.name} (${PERSONA_ID}) × ${scenario.id}`)
  console.log(`  mech: nudge@${mech.patienceNudgeAfter} giveup-ok@${mech.giveUpLegitAfter} maxWait=${mech.maxWaitSeconds}s`)
  browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  await ctx.addInitScript(CURSOR_JS)
  await ctx.addInitScript(SAME_TAB_JS)
  if (scenario.initLocalStorage) {
    await ctx.addInitScript((entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) window.localStorage.setItem(k, v)
    }, scenario.initLocalStorage)
  }
  page = await ctx.newPage()
  // backstop for popups that evade the shim: adopt them into the main view
  ctx.on('page', (popup) => {
    void (async () => {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => { /* */ })
        const url = popup.url()
        await popup.close().catch(() => { /* */ })
        if (url && url !== 'about:blank' && page) {
          console.log(`  (adopted popup into main view: ${url.slice(0, 80)})`)
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => { /* */ })
        }
      } catch { /* */ }
    })()
  })
  tV0 = Date.now()
  await page.goto(scenario.baseUrl + scenario.startPath, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (Date.now() - t0 > WALL_MS) { endState = 'wall-clock'; break }

    const url = page.url()
    urlVisits.set(url, (urlVisits.get(url) ?? 0) + 1)
    const digest = await pageDigest()
    const dHash = hash(digest)
    const reread = dHash === lastDigestHash
    lastDigestHash = dHash

    // Mechanical patience: the harness — not the prose — decides when the
    // persona's mood is allowed to sour or the give-up becomes legitimate.
    let mood = ''
    if (consecNoProgress >= mech.giveUpLegitAfter) {
      mood = `\n(You have tried ${consecNoProgress} things without getting anywhere. As ${persona.name}, giving up now would be completely reasonable — only continue if you genuinely see a way forward.)`
    } else if (consecNoProgress >= mech.patienceNudgeAfter) {
      mood = `\n(Nothing has worked for your last ${consecNoProgress} tries and you can feel your patience wearing thin.)`
    }

    const observation =
      `STEP ${step}/${MAX_STEPS} · elapsed ${Math.round((Date.now() - t0) / 60_000)}min of ${scenario.wallMin}min\n` +
      `=== PAGE ===\n${digest}${mood}`

    const shotB64 = await page
      .screenshot({ type: 'jpeg', quality: 60 })
      .then(b => b.toString('base64'))
      .catch(() => undefined)

    let act: LlmAction
    try { act = await llm(observation, shotB64) } catch (err) {
      console.log(`  llm error: ${(err as Error).message}`); await new Promise(r => setTimeout(r, 5_000)); step--; continue
    }

    if (!act.action?.type) {
      // retry a malformed action (bounded) — a JSON hiccup must not end
      // the session as a fake "give-up" (run-8 lesson)
      malformed += 1
      if (malformed <= 3) {
        history.push({ role: 'user', content: 'Your last reply had no valid "action" — answer again with the exact JSON shape.' })
        step--
        continue
      }
      endState = 'harness-error'
      endDetail = 'model kept returning malformed actions'
      break
    }
    malformed = 0
    const a = act.action
    // Think-aloud lines are conceived BEFORE the hands move — timestamp the
    // decision so the voice track syncs to the action's start, not its end.
    const tDecide = Date.now() - tV0
    let ok = true
    let detail = ''
    try {
      switch (a.type) {
        case 'goto': {
          const u = new URL(a.path ?? '/', scenario.baseUrl)
          if (u.host !== base.host) { ok = false; detail = `blocked: off-app ${u.host}` }
          else { await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }); detail = u.pathname }
          break
        }
        case 'click':
        case 'hover': {
          const target = await resolveTarget(page, a.text ?? '')
          if (!target) throw new Error(`no visible element matching "${a.text}"`)
          await mouseTravelTo(page, target)
          if (a.type === 'click') {
            await page.mouse.down()
            await page.mouse.up()
            detail = `clicked "${a.text}"`
          } else {
            detail = `hovering "${a.text}"`
          }
          await page.waitForTimeout(1_800)
          break
        }
        case 'fill': {
          const t = (a.target ?? '').trim()
          // An empty target matches every input on screen (v3's form title
          // landed in the preview's Email box) — make the persona name it.
          if (!t) throw new Error('fill needs a target — name the box you mean')
          const field = await resolveField(page, t, a.nth)
          if (!field) throw new Error(`no field matching "${t}"`)
          // Type like a person: mouse to the field, click into it, keys.
          await mouseTravelTo(page, field)
          await page.mouse.down()
          await page.mouse.up()
          await field.fill('')
          await page.keyboard.type(a.value ?? '', { delay: 55 })
          detail = `filled "${t}"`
          break
        }
        case 'choose': {
          const t = (a.target ?? '').trim()
          const v = (a.value ?? '').trim()
          if (!t || !v) throw new Error('choose needs a target dropdown and a value')
          // Native <select> first: match by label text, aria, or name.
          const native = page.locator('select').filter({
            has: page.locator(`option`, { hasText: v }),
          }).first()
          const nativeByLabel = page.getByLabel(t).and(page.locator('select')).first()
          const sel = (await nativeByLabel.isVisible().catch(() => false)) ? nativeByLabel
            : (await native.isVisible().catch(() => false)) ? native : null
          if (sel) {
            await mouseTravelTo(page, sel)
            await sel.selectOption({ label: v }).catch(() => sel.selectOption(v))
            detail = `chose "${v}" in "${t}"`
          } else {
            // Custom dropdown: open it like a person, then click the option.
            const opener = await resolveTarget(page, t)
            if (!opener) throw new Error(`no dropdown matching "${t}"`)
            await mouseTravelTo(page, opener)
            await page.mouse.down(); await page.mouse.up()
            await page.waitForTimeout(900)
            const option = page.getByRole('option', { name: v }).first()
            const target = (await option.isVisible().catch(() => false))
              ? option
              : await resolveTarget(page, v)
            if (!target) throw new Error(`the dropdown opened but no option matching "${v}" is visible`)
            await mouseTravelTo(page, target)
            await page.mouse.down(); await page.mouse.up()
            detail = `chose "${v}" in "${t}"`
          }
          await page.waitForTimeout(1_200)
          break
        }
        case 'press': await page.keyboard.press(a.key ?? 'Enter'); detail = `pressed ${a.key}`; break
        case 'wait': {
          const s = Math.min(a.seconds ?? 20, mech.maxWaitSeconds)
          detail = `waited ${s}s on: ${a.watching ?? '?'}`
          await new Promise(r => setTimeout(r, s * 1_000))
          break
        }
        case 'done': endState = 'done'; endDetail = a.summary ?? ''; detail = a.summary ?? ''; break
        case 'stuck': endState = 'gave-up'; endDetail = a.why ?? ''; detail = a.why ?? ''; break
        default: ok = false; detail = `unknown action ${a.type}`
      }
    } catch (err) {
      ok = false
      detail = `${detail || a.type} FAILED: ${(err as Error).message.split('\n')[0]?.slice(0, 140)}`
    }

    const emotion: Emotion = (EMOTIONS as readonly string[]).includes(act.emotion ?? '')
      ? (act.emotion as Emotion)
      : 'neutral'
    const say = (act.say ?? '').trim().slice(0, 160)

    events.push({
      step, t: tDecide, url, thought: act.thought, say, emotion,
      action: `${a.type} ${detail}`.trim() + (reread && events.length ? ' [re-read]' : ''),
      detail, ok, confusion: act.confusion, quote: act.quote,
    })
    consecNoProgress = (!ok || reread) ? consecNoProgress + 1 : 0
    console.log(`  ${String(step).padStart(2)} ${ok ? '·' : '✗'} ${emotion.padEnd(10)} ${a.type.padEnd(6)} ${detail.slice(0, 80)}${say ? `\n     🗣 "${say}"` : ''}${act.confusion ? `\n     😕 ${act.confusion.slice(0, 110)}` : ''}`)
    await snap(`${a.type}`)
    // Human pacing: a person scans the page before and after acting; the
    // model doesn't. Without this the film is unwatchably fast and the
    // think-aloud lines have no room to land (rig humanPacing lesson).
    await page.waitForTimeout(1_200 + say.length * 30)
    history.push({ role: 'user', content: `ACTION RESULT: ${ok ? 'ok' : 'FAILED'} — ${detail}` })

    if (endState === 'done' || endState === 'gave-up') break
  }
}

// ── report + teardown ─────────────────────────────────────────────────────
const report = async (): Promise<void> => {
  const video = page?.video()
  try { await page?.context().close() } catch { /* */ }
  let videoFile = ''
  try {
    if (video) { await video.saveAs(join(OUT, 'screen.webm')); await video.delete(); videoFile = 'screen.webm' }
  } catch (err) { console.log(`video save failed: ${(err as Error).message}`) }
  try { await browser?.close() } catch { /* */ }

  writeFileSync(join(OUT, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))

  // emotion timeline: one entry per change, timestamps video-relative
  const emotionArc: { t: number; emotion: Emotion }[] = []
  for (const e of events) {
    if (!emotionArc.length || emotionArc[emotionArc.length - 1]!.emotion !== e.emotion) {
      emotionArc.push({ t: e.t, emotion: e.emotion })
    }
  }

  const wallMin = (Date.now() - t0) / 60_000
  const llmUsd = (cogs.tokensIn * PRICE_IN + cogs.tokensOut * PRICE_OUT) / 1e6
  writeFileSync(join(OUT, 'cogs.json'), JSON.stringify({
    runId, model: MODEL,
    llm: { calls: cogs.llmCalls, tokensIn: cogs.tokensIn, tokensOut: cogs.tokensOut, usd: Number(llmUsd.toFixed(4)) },
    // filled in by the reaction-cam / compositing pipeline:
    tts: null, avtr: null,
    wallMin: Number(wallMin.toFixed(1)),
  }, null, 2))

  // Derived success (D5): ask the app, not the persona. A step-capped run
  // that actually met the goal counts; a self-reported "done" that
  // didn't, doesn't (suite msxioqn6 lesson: sample published the form on
  // its literal last allowed step and was misreported as a failure).
  let verified: { success: boolean; evidence: string } | null = null
  if (scenario.verify?.cmd) {
    try {
      const [cmd, ...rest] = scenario.verify.cmd.split(' ')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      // run dir as last arg: information-task verifiers read the ledger
      const { stdout } = await promisify(execFile)(cmd!, [...rest, OUT], { timeout: 60_000 })
      verified = JSON.parse(stdout.trim().split('\n').pop() ?? 'null')
      console.log(`verified: ${verified?.success} — ${verified?.evidence}`)
    } catch (err) {
      console.log(`verifier failed: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  writeFileSync(join(OUT, 'run.json'), JSON.stringify({
    runId, persona: PERSONA_ID, scenario: scenario.id, target: scenario.target,
    endState, endDetail, verified,
    metrics: {
      steps: events.length,
      wallMin: Number(wallMin.toFixed(1)),
      deadEnds: events.filter(e => !e.ok).length,
      confusions: events.filter(e => e.confusion).length,
      waits: events.filter(e => e.action.startsWith('wait')).length,
      backtracks: [...urlVisits.values()].filter(v => v > 2).length,
    },
    emotionArc,
    sayLines: events.filter(e => e.say).map(e => ({ t: e.t, say: e.say, emotion: e.emotion })),
    video: videoFile,
  }, null, 2))

  const L: string[] = []
  L.push(`# sim run ${runId} — ${persona.name} × ${scenario.id} — ended: ${endState}`)
  L.push(`\nDate: ${new Date().toISOString()}`)
  L.push(`End detail: ${endDetail || '—'}`)
  L.push(`\n## Journey\n- steps: ${events.length} · wall: ${wallMin.toFixed(1)} min · dead-ends: ${events.filter(e => !e.ok).length} · confusions: ${events.filter(e => e.confusion).length}`)
  L.push(`- llm: ${cogs.llmCalls} calls, ${cogs.tokensIn}+${cogs.tokensOut} tokens, $${llmUsd.toFixed(4)}`)
  L.push(`\n## Emotion arc\n${emotionArc.map(s => `- ${(s.t / 1000).toFixed(0)}s ${s.emotion}`).join('\n')}`)
  L.push(`\n## Think-aloud`)
  for (const e of events.filter(x => x.say)) L.push(`- [${(e.t / 1000).toFixed(0)}s][${e.emotion}] "${e.say}"`)
  L.push(`\n## Confusion notes`)
  for (const e of events.filter(x => x.confusion)) L.push(`- [step ${e.step}] ${e.confusion}${e.quote ? ` — "${e.quote}"` : ''}`)
  L.push(`\nArtifacts: events.jsonl, run.json, cogs.json, ${videoFile || '(no video)'}, shots/.`)
  writeFileSync(join(OUT, 'report.md'), L.join('\n'))
  console.log(`\nrun dir: ${OUT}\nended: ${endState} — ${endDetail.slice(0, 120)}`)
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// hasText matches ancestors and hidden duplicates — pick the VISIBLE
// candidate with the tightest own text (bench lesson).
async function pickTightest(loc: ReturnType<Page['locator']>) {
  const n = Math.min(await loc.count(), 12)
  let best: { i: number; len: number } | null = null
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    const len = ((await el.textContent().catch(() => '')) ?? '').trim().length
    if (!best || len < best.len) best = { i, len }
  }
  return best ? loc.nth(best.i) : null
}

// Semantic controls first; then ANY element with that text — apps hang
// click handlers off plain divs/spans and users neither know nor care
// about tag semantics. "(icon: name)" targets from the digest resolve to
// the control containing that icon.
async function resolveTarget(pg: Page, text: string) {
  const iconM = /\(?icon:?\s*([a-z0-9-]+)\)?/i.exec(text)
  if (iconM) {
    const byIcon = await pickTightest(
      pg.locator(`button:has([class*="${iconM[1]}"]), [role="button"]:has([class*="${iconM[1]}"])`),
    )
    if (byIcon) return byIcon
  }
  const re = new RegExp(escapeRe(text), 'i')
  return (
    (await pickTightest(pg.locator('button, [role="button"], a', { hasText: re }))) ??
    (await pickTightest(pg.getByText(re))) ??
    // "click the Enter-your-email box" — inputs are named by placeholder
    (await resolveField(pg, text))
  )
}

// nth (1-based, from the persona's own count of matching boxes) wins;
// otherwise prefer an EMPTY matching field so "fill the Option Text box"
// twice lands in the next blank option, not over the first (run-4/5
// lesson: the options carry default VALUES, so empty-preference alone
// still overwrote — the vision model now names the box it means).
async function resolveField(pg: Page, t: string, nth?: number) {
  // A sighted user names a box by whatever it SHOWS: placeholder, label,
  // or its current value ("the Option 2 box"). Match all three.
  const cands = pg.locator('input, textarea')
  const n = Math.min(await cands.count(), 40)
  const tLow = t.toLowerCase()
  const visible: ReturnType<Page['locator']>[] = []
  let empty: ReturnType<Page['locator']> | null = null
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    const ph = ((await el.getAttribute('placeholder').catch(() => '')) ?? '').toLowerCase()
    const val = (await el.inputValue().catch(() => '')).toLowerCase()
    const aria = ((await el.getAttribute('aria-label').catch(() => '')) ?? '').toLowerCase()
    if (!ph.includes(tLow) && !val.includes(tLow) && !aria.includes(tLow)) continue
    visible.push(el)
    if (!empty && !val.trim()) empty = el
  }
  if (nth && nth >= 1 && nth <= visible.length) return visible[nth - 1]!
  if (empty) return empty
  if (visible.length) return visible[0]!
  const byLabel = pg.getByLabel(new RegExp(escapeRe(t), 'i')).first()
  return (await byLabel.count()) ? byLabel : null
}

// Move the real mouse in visible steps so the injected cursor travels and
// hover states fire like they would for a person.
async function mouseTravelTo(pg: Page, target: ReturnType<Page['locator']>): Promise<void> {
  await target.scrollIntoViewIfNeeded().catch(() => { /* */ })
  const bb = await target.boundingBox()
  if (!bb) throw new Error('target has no box')
  const tx = bb.x + Math.min(bb.width / 2, 160)
  const ty = bb.y + Math.min(bb.height / 2, 40)
  await pg.mouse.move(tx, ty, { steps: 22 })
  await pg.waitForTimeout(180)
}

main()
  .catch((err) => { endState = 'harness-error'; endDetail = (err as Error).message; console.error('ABORT:', err) })
  .finally(async () => { await report(); process.exit(0) })
