// AUTO-SYNCED from holostaff-agent/server/scripts/sim/digest.ts — do not edit here.
// Re-sync: bash server/scripts/sim/sync-cli-engine.sh
/**
 * The page digest the persona engine and the autopilot share — dialog
 * aware, icon labels, dropdown options. One source of truth: the engine
 * perceives with it, the harness feeds it to the autopilot brain, and
 * the SDK digest mirrors it (P6). Earned over five P0 iterations; treat
 * changes as perception-grammar changes.
 */

export const DIGEST_JS = `(() => {
  const out = []
  // Interactive tags get ordinal disambiguation instead of dedup (P6.1):
  // five identical "Message" blocks list as "Message #2/5" etc., or block
  // N can never be targeted. Prose tags keep dedup.
  const ORDINAL_TAGS = { button: 1, link: 1, input: 1, dropdown: 1 }
  const entries = []
  const seen = new Set()
  const push = (tag, text, el) => {
    const t = (text || '').replace(/\\s+/g, ' ').trim().slice(0, 140)
    if (!t) return
    if (!ORDINAL_TAGS[tag]) { if (seen.has(tag + t)) return; seen.add(tag + t) }
    entries.push([tag, t, el || null])
  }
  // Containment (P6.1 slice 3): the nearest labeled container a control
  // lives in — keep in lockstep with containerLabelFor in sdk/src/actions.ts.
  const CONTAINER_SEL = 'li, tr, fieldset, section, article, [role="group"], [role="listitem"], [role="row"], [class*="card"], [class*="block"], [class*="item"], [class*="panel"], [class*="row"], [class*="step"], [class*="field"]'
  const TITLE_SEL = 'h1,h2,h3,h4,h5,h6,label,strong,b,[class*="title"],[class*="name"],[class*="label"],[class*="heading"],input,textarea'
  const containerLabel = (el, ownLabel) => {
    let cur = el.parentElement
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++, cur = cur.parentElement) {
      if (!cur.matches || !cur.matches(CONTAINER_SEL)) continue
      const r = cur.getBoundingClientRect()
      if (r.height > innerHeight * 0.85) break
      let tried = 0
      for (const cand of cur.querySelectorAll(TITLE_SEL)) {
        if (tried++ >= 6) break
        if (cand.contains(el) || el.contains(cand)) continue
        const raw = (cand.tagName === 'INPUT' || cand.tagName === 'TEXTAREA')
          ? (cand.value || cand.placeholder || '')
          : (cand.textContent || '')
        const t = raw.replace(/\\s+/g, ' ').trim()
        if (t && t.length <= 40 && t !== ownLabel) return t
      }
    }
    return ''
  }
  const finish = () => {
    const globalCounts = new Map()
    for (const [g, t] of entries) globalCounts.set(g + '\\0' + t, (globalCounts.get(g + '\\0' + t) || 0) + 1)
    // Ambiguous or icon-only controls get their block's name —
    // "(icon: cog) [in: Name]" — so the reader knows WHICH block a
    // control configures. Ordinals then count within the annotated
    // label, i.e. per block.
    const annotated = entries.map(([g, t, el]) => {
      const needsHome = ORDINAL_TAGS[g] && el
        && ((globalCounts.get(g + '\\0' + t) || 0) > 1 || t.indexOf('(icon:') === 0)
      const home = needsHome ? containerLabel(el, t) : ''
      return [g, home ? t + ' [in: ' + home.slice(0, 40) + ']' : t]
    })
    const counts = new Map()
    for (const [g, t] of annotated) counts.set(g + '\\0' + t, (counts.get(g + '\\0' + t) || 0) + 1)
    const nth = new Map()
    for (const [g, t] of annotated) {
      const k = g + '\\0' + t, n = counts.get(k)
      if (n > 1) {
        const i = (nth.get(k) || 0) + 1
        nth.set(k, i)
        if (i > 8) continue
        out.push(g + ': ' + t + ' #' + i + '/' + n)
      } else out.push(g + ': ' + t)
    }
  }
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight * 2.2
  }
  let root = document
  const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [class*="modal"] [class*="content"], [id*="modal"]')]
    .filter(el => {
      if (!vis(el)) return false
      const r = el.getBoundingClientRect()
      return r.width * r.height > innerWidth * innerHeight * 0.08 && r.width < innerWidth * 0.95
    })
  if (dialogs.length) {
    root = dialogs[dialogs.length - 1]
    out.push('note: A DIALOG IS OPEN on top of the page — the page behind it is dimmed and NOT clickable. Only what is listed below (the dialog) is interactive right now.')
  }
  root.querySelectorAll('h1,h2,h3,[class*="title"]').forEach(el => { if (vis(el)) push('heading', el.textContent) })
  root.querySelectorAll('button,[role="button"],a[href]').forEach(el => {
    if (!vis(el)) return
    let label = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || ''
    if (!label) {
      const ic = el.querySelector('[class*="i-"]')
      const m = ic && /i-[a-z0-9-]+:([a-z0-9-]+)/.exec(ic.className || '')
      if (m) label = '(icon: ' + m[1].replace(/-\\d+-(solid|outline)$/, '') + ')'
    }
    push(el.tagName === 'A' ? 'link' : 'button', label, el)
  })
  root.querySelectorAll('input,textarea,select').forEach(el => {
    if (!vis(el)) return
    const lbl = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : ''
    if (el.tagName === 'SELECT') {
      // dropdowns carry their choices — the persona can only pick what it can see
      const opts = Array.from(el.options || []).map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 12)
      const cur = el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].textContent || '').trim() : ''
      push('dropdown', 'label="' + lbl + '" current="' + cur + '" options=[' + opts.join(' | ') + ']', el)
      return
    }
    push('input', (el.type || el.tagName.toLowerCase()) + ' placeholder="' + (el.placeholder || '') + '" label="' + lbl + '"', el)
  })
  root.querySelectorAll('code,pre,[class*="alert"],[class*="empty"],[class*="toast"]').forEach(el => { if (vis(el)) push('text', el.textContent) })
  root.querySelectorAll('p,li,span[class*="caption"],[class*="subtitle"]').forEach(el => {
    if (vis(el) && (el.textContent || '').trim().length > 25) push('copy', el.textContent)
  })
  finish()
  return out.slice(0, 90).join('\\n')
})()`
