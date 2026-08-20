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
  const seen = new Set()
  const push = (tag, text) => {
    const t = (text || '').replace(/\\s+/g, ' ').trim().slice(0, 140)
    if (!t || seen.has(tag + t)) return
    seen.add(tag + t); out.push(tag + ': ' + t)
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
    push(el.tagName === 'A' ? 'link' : 'button', label)
  })
  root.querySelectorAll('input,textarea,select').forEach(el => {
    if (!vis(el)) return
    const lbl = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : ''
    if (el.tagName === 'SELECT') {
      // dropdowns carry their choices — the persona can only pick what it can see
      const opts = Array.from(el.options || []).map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 12)
      const cur = el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].textContent || '').trim() : ''
      push('dropdown', 'label="' + lbl + '" current="' + cur + '" options=[' + opts.join(' | ') + ']')
      return
    }
    push('input', (el.type || el.tagName.toLowerCase()) + ' placeholder="' + (el.placeholder || '') + '" label="' + lbl + '"')
  })
  root.querySelectorAll('code,pre,[class*="alert"],[class*="empty"],[class*="toast"]').forEach(el => { if (vis(el)) push('text', el.textContent) })
  root.querySelectorAll('p,li,span[class*="caption"],[class*="subtitle"]').forEach(el => {
    if (vis(el) && (el.textContent || '').trim().length > 25) push('copy', el.textContent)
  })
  return out.slice(0, 90).join('\\n')
})()`
