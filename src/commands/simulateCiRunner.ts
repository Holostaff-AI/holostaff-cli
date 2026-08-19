/**
 * `holostaff simulate --ci` — run the workspace's canvas scenarios inside
 * a CI job (user-simulation PRD P4, D8: in-CI is the default).
 *
 * The job's ingredients, and where each comes from:
 *   recipe     ./.holostaff/environment.json (merged via the recipe PR, D12)
 *   scenarios  the source's live artifact (GET /api/cli/sim/manifest)
 *   personas   the workspace Studio (same manifest)
 *   account    CI secrets: HOLOSTAFF_SIM_ACCOUNT_EMAIL / _PASSWORD
 *   model      Holostaff's metered proxy (or the job's own OPENAI_API_KEY)
 *   results    POST /api/cli/sim/results → the workspace Results surface
 *
 * The engine itself ships with this package (src/engine, synced from the
 * platform repo). Recordings stay in the job's artifact store in v1.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import type { SimulateArgs } from './argv.js'

const HERE = dirname(fileURLToPath(import.meta.url))

interface Recipe {
  target?: string
  serve?: {
    kind?: string
    workDir?: string
    files?: string[]
    command?: string
    buildCommand?: string
    depsCompose?: string
    healthUrl?: string
    healthTimeoutMs?: number
    env?: Record<string, string>
  }
  initLocalStorage?: Record<string, string>
}

interface ManifestScenario {
  id: string
  workflowName: string
  personaIds: string[]
  spec: Record<string, unknown> & { guards?: { maxSteps?: number; wallMin?: number } }
}

interface Manifest {
  personas: Array<Record<string, unknown> & { id: string }>
  scenarios: ManifestScenario[]
  budget?: { monthlyRuns: number; used: number; remaining: number }
}

/** Optional repo-side suite config (.holostaff/simulate.json) — reviewable
 *  in the repo like the recipe (D12). */
interface SuiteConfig {
  scenarios?: string[]
  samples?: number
  thresholds?: { minSuccessRate?: number }
}

const log = (m: string) => process.stderr.write(`holostaff sim: ${m}\n`)

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000) })
    return res.status < 500
  } catch { return false }
}

async function serveUp(recipe: Recipe, cwd: string): Promise<void> {
  const serve = recipe.serve ?? {}
  const url = serve.healthUrl
  if (!url) throw new Error('the recipe has no serve.healthUrl')
  if (await healthy(url)) { log(`app already answering at ${url}`); return }

  const env = { ...process.env, ...(serve.env ?? {}) }
  if (serve.kind === 'compose' && serve.files?.length) {
    const fileArgs = serve.files.flatMap(f => ['-f', f])
    log(`docker compose up (${serve.files.join(', ')})`)
    const r = spawnSync('docker', ['compose', ...fileArgs, 'up', '-d'], {
      cwd: join(cwd, serve.workDir ?? '.'), env, stdio: 'inherit',
    })
    if (r.status !== 0) log('compose up exited nonzero; waiting on health anyway (slow cold boots recover)')
  } else if (serve.kind === 'external' && serve.command) {
    const wd = join(cwd, serve.workDir ?? '.')
    if (serve.depsCompose) {
      spawnSync('docker', ['compose', '-f', serve.depsCompose, 'up', '-d'], { cwd: wd, env, stdio: 'inherit' })
    }
    if (serve.buildCommand) {
      log(`build: ${serve.buildCommand}`)
      const b = spawnSync('sh', ['-c', serve.buildCommand], { cwd: wd, env, stdio: 'inherit' })
      if (b.status !== 0) throw new Error('the recipe buildCommand failed')
    }
    log(`start: ${serve.command}`)
    const child = spawn('sh', ['-c', serve.command], { cwd: wd, env, detached: true, stdio: 'ignore' })
    child.unref()
  } else {
    throw new Error(`serve.kind "${serve.kind}" is not runnable in CI yet`)
  }

  const timeoutMs = serve.healthTimeoutMs ?? 600_000
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await healthy(url)) { log(`app is up at ${url}`); return }
    await new Promise(r => setTimeout(r, 5_000))
  }
  throw new Error(`the app never answered at ${url} within ${Math.round(timeoutMs / 1000)}s`)
}

export async function runSimulateCiMode(opts: SimulateArgs): Promise<number> {
  const apiKey = process.env.HOLOSTAFF_API_KEY ?? ''
  const apiBase = (process.env.HOLOSTAFF_API_BASE_URL
    ?? 'https://holostaff-vision-1008066443043.us-central1.run.app').replace(/\/$/, '')
  if (!apiKey) { log('HOLOSTAFF_API_KEY is required in CI mode'); return 2 }
  const sourceId = opts.sourceId ?? process.env.HOLOSTAFF_SOURCE_ID ?? ''
  if (!sourceId) { log('pass --source <id> or set HOLOSTAFF_SOURCE_ID'); return 2 }

  const recipePath = join(process.cwd(), '.holostaff', 'environment.json')
  if (!existsSync(recipePath)) {
    log('no .holostaff/environment.json in this repo. Merge the environment recipe PR first.')
    return 2
  }
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as Recipe

  log(`fetching scenarios + personas for ${sourceId}`)
  const mres = await fetch(`${apiBase}/api/cli/sim/manifest?sourceId=${encodeURIComponent(sourceId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!mres.ok) { log(`manifest fetch failed: HTTP ${mres.status} ${(await mres.text()).slice(0, 200)}`); return 2 }
  const manifest = await mres.json() as Manifest
  let scenarios = manifest.scenarios
  if (opts.scenarioId) scenarios = scenarios.filter(s => s.id === opts.scenarioId)

  const suitePath = join(process.cwd(), '.holostaff', 'simulate.json')
  const suite: SuiteConfig = existsSync(suitePath)
    ? JSON.parse(readFileSync(suitePath, 'utf8')) as SuiteConfig
    : {}
  if (Array.isArray(suite.scenarios) && suite.scenarios.length) {
    scenarios = scenarios.filter(s => suite.scenarios!.includes(s.id))
  }
  const samples = Math.max(1, suite.samples ?? 1)
  const minSuccessRate = suite.thresholds?.minSuccessRate ?? 1.0

  if (!scenarios.length) { log('no scenarios to run. Author one on the journey map canvas.'); return 2 }
  log(`${scenarios.length} scenario(s) × ${samples} sample(s), ${manifest.personas.length} persona(s) in the workspace`)

  // D20: monthly run budget — plan the job, skip what exceeds the budget,
  // and say so with a visible annotation (never silently).
  const planned = scenarios.reduce((n, s) => n + Math.max(1, s.personaIds.length || 1) * samples, 0)
  const budget = manifest.budget
  let allowance = planned
  if (budget) {
    allowance = Math.min(planned, budget.remaining)
    if (budget.remaining < planned) {
      const msg = `monthly run budget: ${budget.used}/${budget.monthlyRuns} used — running ${allowance} of ${planned} planned run(s), skipping the rest`
      log(msg)
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Holostaff run budget::${msg}`)
    } else if (budget.monthlyRuns > 0 && (budget.used + planned) / budget.monthlyRuns >= 0.8) {
      const msg = `monthly run budget at ${Math.round(((budget.used + planned) / budget.monthlyRuns) * 100)}% after this job (${budget.used + planned}/${budget.monthlyRuns})`
      log(msg)
      if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Holostaff run budget::${msg}`)
    }
  }
  let skipped = 0

  await serveUp(recipe, process.cwd())
  if (opts.preflightOnly) { log('preflight-only: done'); return 0 }

  // Materialize the engine's working dir: persona + scenario sheets.
  const simDir = join(tmpdir(), `holostaff-sim-${Date.now().toString(36)}`)
  mkdirSync(join(simDir, 'personas'), { recursive: true })
  mkdirSync(join(simDir, 'scenarios'), { recursive: true })
  const outDir = join(process.cwd(), '.holostaff', 'sim-runs')
  mkdirSync(outDir, { recursive: true })
  for (const p of manifest.personas) {
    writeFileSync(join(simDir, 'personas', `${p.id}.json`), JSON.stringify(p, null, 2))
  }

  const account = process.env.HOLOSTAFF_SIM_ACCOUNT_EMAIL && process.env.HOLOSTAFF_SIM_ACCOUNT_PASSWORD
    ? { email: process.env.HOLOSTAFF_SIM_ACCOUNT_EMAIL, password: process.env.HOLOSTAFF_SIM_ACCOUNT_PASSWORD }
    : undefined
  const baseUrl = new URL(recipe.serve!.healthUrl!).origin

  const engine = join(HERE, '..', 'engine', 'run.js')
  if (!existsSync(engine)) { log(`bundled engine missing at ${engine}`); return 2 }

  // Model access: the job's own key wins; otherwise Holostaff's metered proxy.
  const modelEnv = process.env.OPENAI_API_KEY
    ? {}
    : { SIM_MODEL_BASE_URL: `${apiBase}/api/cli/sim`, SIM_MODEL_KEY: apiKey }

  interface RunRow {
    scenario: string
    persona: string
    endState: string
    steps: number | null
    wallMin: number | null
    confusions: number | null
    exitLine: string
    resultId?: string
  }
  const rows: RunRow[] = []
  let failures = 0
  let ran = 0
  // Level 1 workflow certification (autopilots PRD §6.1): per-workflow
  // tallies, reported to the workspace after the suite so the Autopilots
  // surface shows certification state per workflow.
  const wfTally = new Map<string, { runs: number; failures: number; runIds: string[] }>()
  const tallyFor = (wf: string) => {
    let t = wfTally.get(wf)
    if (!t) { t = { runs: 0, failures: 0, runIds: [] }; wfTally.set(wf, t) }
    return t
  }
  for (const scenario of scenarios) {
    const personaIds = scenario.personaIds.length ? scenario.personaIds : manifest.personas.slice(0, 1).map(p => p.id)
    const spec = {
      id: scenario.id,
      target: recipe.target ?? 'app',
      baseUrl,
      ...(recipe.initLocalStorage ? { initLocalStorage: recipe.initLocalStorage } : {}),
      ...(account ? { credentials: account } : {}),
      startPath: (scenario.spec.startPath as string) ?? '/',
      context: (scenario.spec.context as string) ?? '',
      goal: typeof scenario.spec.goal === 'object' && scenario.spec.goal
        ? String((scenario.spec.goal as { text?: string }).text ?? '')
        : String(scenario.spec.goal ?? ''),
      maxSteps: scenario.spec.guards?.maxSteps ?? 45,
      wallMin: scenario.spec.guards?.wallMin ?? 20,
      ...(scenario.spec.testCard ? { testCard: scenario.spec.testCard } : {}),
    }
    writeFileSync(join(simDir, 'scenarios', `${scenario.id}.json`), JSON.stringify(spec, null, 2))

    for (const personaId of personaIds) {
      if (!manifest.personas.some(p => p.id === personaId)) continue
      for (let sample = 0; sample < samples; sample++) {
      if (ran >= allowance) { skipped++; continue }
      ran++
      log(`run: ${scenario.spec.name ?? scenario.id} as ${personaId}`)
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [engine, '--persona', personaId, '--scenario', scenario.id], {
          env: { ...process.env, SIM_DIR: simDir, SIM_OUT: outDir, ...modelEnv },
          stdio: 'inherit',
        })
        child.on('close', c => resolve(c ?? 1))
        child.on('error', () => resolve(1))
      })
      if (code !== 0) { failures++; continue }

      // newest run dir carries the result
      const latest = readdirSync(outDir).map(d => join(outDir, d))
        .filter(d => existsSync(join(d, 'run.json')))
        .sort((a, b) => (a < b ? 1 : -1))[0]
      if (!latest) { failures++; continue }
      const runJson = JSON.parse(readFileSync(join(latest, 'run.json'), 'utf8')) as { endState?: string }
      const cogs = existsSync(join(latest, 'cogs.json'))
        ? JSON.parse(readFileSync(join(latest, 'cogs.json'), 'utf8'))
        : null
      if (runJson.endState !== 'done') failures++
      const tally = tallyFor(scenario.workflowName || 'workflow')
      tally.runs++
      if (runJson.endState !== 'done') tally.failures++
      const rj = runJson as {
        endState?: string
        endDetail?: string
        metrics?: { steps?: number; wallMin?: number; confusions?: number }
        sayLines?: Array<{ say?: string }>
      }
      rows.push({
        scenario: String(scenario.spec.name ?? scenario.id),
        persona: String(manifest.personas.find(p => p.id === personaId)?.name ?? personaId),
        endState: rj.endState ?? '?',
        steps: rj.metrics?.steps ?? null,
        wallMin: rj.metrics?.wallMin ?? null,
        confusions: rj.metrics?.confusions ?? null,
        exitLine: (rj.endDetail || rj.sayLines?.slice(-1)[0]?.say || '').slice(0, 140),
      })
      const up = await fetch(`${apiBase}/api/cli/sim/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioId: scenario.id,
          personaId,
          name: scenario.spec.name ?? scenario.id,
          sourceId,
          runJson,
          cogs,
        }),
      })
      log(up.ok ? `result uploaded (${runJson.endState})` : `result upload failed: HTTP ${up.status}`)
      if (up.ok) {
        const { resultId } = await up.json() as { resultId?: string }
        if (rows.length) rows[rows.length - 1]!.resultId = resultId
        if (resultId) tally.runIds.push(resultId)
        // ship the screen recording so the workspace can compose the
        // rehearsal clip on demand (lazy render)
        const videoName = (runJson as { video?: string }).video ?? 'screen.webm'
        const videoPath = join(latest, videoName)
        if (resultId && existsSync(videoPath)) {
          const rec = await fetch(`${apiBase}/api/cli/sim/results/${resultId}/recording`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'video/webm' },
            body: readFileSync(videoPath),
          }).catch(() => null)
          log(rec?.ok ? 'recording uploaded (clip renders on view)' : 'recording upload skipped')
        }
      }
      }
    }
  }

  const successRate = ran > 0 ? (ran - failures) / ran : 0
  // A budget skip is not a failure (D20): an all-skipped job passes with
  // its annotation. A job that ran nothing for other reasons fails loud.
  const passed = ran === 0 ? skipped > 0 : successRate >= minSuccessRate
  log(`${ran} run(s), ${failures} missed the goal, success rate ${(successRate * 100).toFixed(0)}% (threshold ${(minSuccessRate * 100).toFixed(0)}%)${skipped ? `, ${skipped} skipped over budget` : ''}`)

  // Report Level 1 workflow certification per workflow (best-effort: an
  // older server without the endpoint never fails the job).
  interface CertLine { workflow: string; passed: boolean; ok: number; runs: number }
  const certLines: CertLine[] = []
  for (const [workflow, t] of wfTally) {
    if (t.runs === 0) continue
    const rate = (t.runs - t.failures) / t.runs
    const certPassed = rate >= minSuccessRate
    certLines.push({ workflow, passed: certPassed, ok: t.runs - t.failures, runs: t.runs })
    const cres = await fetch(`${apiBase}/api/cli/sim/certifications`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId,
        workflowName: workflow,
        passed: certPassed,
        rate,
        threshold: minSuccessRate,
        runs: t.runs,
        failures: t.failures,
        commit: process.env.GITHUB_SHA ?? undefined,
        branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || undefined,
        runIds: t.runIds,
      }),
    }).catch(() => null)
    log(cres?.ok
      ? `certification recorded: ${workflow} ${certPassed ? 'passed' : 'FAILED'} (${t.runs - t.failures}/${t.runs})`
      : `certification report skipped for ${workflow} (server did not accept it)`)
  }

  if (opts.report) {
    const OUTCOME: Record<string, string> = {
      done: '✅ reached the goal',
      'gave-up': '🛑 gave up',
      'step-cap': '⚠️ ran out of steps',
      'wall-cap': '⚠️ ran out of time',
    }
    const lines: string[] = []
    lines.push('## 🎭 Holostaff simulation')
    lines.push('')
    lines.push(ran === 0 && skipped > 0
      ? 'No runs executed: the monthly run budget is used up.'
      : `Synthetic users ran this branch. ${failures === 0 ? 'Every run reached its goal.' : `${failures} of ${ran} run(s) missed the goal.`} Success rate ${(successRate * 100).toFixed(0)}% against a ${(minSuccessRate * 100).toFixed(0)}% threshold: ${passed ? 'pass.' : 'fail.'}`)
    if (skipped) lines.push('')
    if (skipped) lines.push(`⏭️ ${skipped} run(s) were skipped: the monthly run budget is used up. Raise it in workspace settings or wait for the new month.`)
    lines.push('')
    lines.push('| Scenario | Persona | Outcome | Steps | Minutes | Confusions |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of rows) {
      lines.push(`| ${r.scenario} | ${r.persona} | ${OUTCOME[r.endState] ?? r.endState} | ${r.steps ?? ''} | ${r.wallMin ?? ''} | ${r.confusions ?? ''} |`)
    }
    lines.push('')
    if (certLines.length) {
      for (const c of certLines) {
        lines.push(c.passed
          ? `- **${c.workflow}**: workflow certified (${c.ok}/${c.runs} runs)`
          : `- **${c.workflow}**: workflow certification failed (${c.ok}/${c.runs} runs, threshold ${(minSuccessRate * 100).toFixed(0)}%)`)
      }
      lines.push('')
    }
    for (const r of rows) {
      if (r.exitLine) lines.push(`> **${r.persona}**, at the end: "${r.exitLine}"${r.resultId ? ` — [watch this run](https://www.holostaff.ai/impact?run=${encodeURIComponent(r.resultId)})` : ''}`)
    }
    lines.push('')
    lines.push('All numbers are synthetic (simulated users, not real traffic). Watch the runs on the [Results surface](https://www.holostaff.ai/impact).')
    writeFileSync(opts.report, lines.join('\n') + '\n')
    log(`report written to ${opts.report}`)
  }
  return passed ? 0 : 1
}
