/**
 * Page-mockup capture (canvas visual fidelity) — host-agnostic.
 *
 * Runs at the end of a scan, against the LOCAL working tree, so it works
 * for any host (GitHub, GitLab, Bitbucket, plain git, none). For each
 * `page` step it bundles the route's source file + its 1-level imports
 * (BOTH relative `./` AND alias `@/…` — resolved from vite/tsconfig) +
 * the design-system style files, posts the bundles to the Holostaff
 * render proxy (which fans them out to the render service), and folds the
 * returned `visualRef` URLs back into the artifact's page steps.
 *
 * Strictly fail-soft + additive: any error just means a step keeps no
 * visualRef and the canvas shows the abstract node. Never throws.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { renderMockups, type RenderMockupItem } from '../auth/api.js'

const MAX_BUNDLE_BYTES = 200 * 1024
const MAX_IMPORTS_PER_PAGE = 10
const MAX_FILE_BYTES = 48 * 1024
const RESOLVE_EXTS = ['', '.vue', '.tsx', '.ts', '.jsx', '.js']

interface Artifactish {
  routes?: Array<{ path?: string; file?: string }>
  workflows?: Array<{ name?: string; steps?: Array<Record<string, unknown>> }>
  designTokens?: { source?: string[] } & Record<string, unknown>
  primaryFramework?: string
}

export interface CaptureOptions {
  repoRoot: string
  baseUrl: string
  bearer: string
  sourceId: string
  artifact: Artifactish
}

export interface CaptureResult { requested: number; rendered: number }

interface Alias { prefix: string; dir: string }

function readFileCapped(abs: string): string | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null
    return readFileSync(abs).subarray(0, MAX_FILE_BYTES).toString('utf8')
  } catch { return null }
}

/** Resolve a base path to a real file, trying extensions + /index. */
function resolveFile(base: string): string | null {
  for (const e of RESOLVE_EXTS) {
    const p = base + e
    try { if (existsSync(p) && statSync(p).isFile()) return p } catch { /* */ }
  }
  for (const e of RESOLVE_EXTS.slice(1)) {
    const p = join(base, 'index' + e)
    try { if (existsSync(p) && statSync(p).isFile()) return p } catch { /* */ }
  }
  return null
}

/** Path aliases from vite.config / tsconfig so we can follow `@/…` imports
 *  (the common case for composed pages — without this the model only sees
 *  the page shell and invents the rest). Best-effort. */
function loadAliases(repoRoot: string): Alias[] {
  const aliases: Alias[] = []

  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = readFileSync(join(repoRoot, f), 'utf8').replace(/\/\/[^\n]*/g, '')
      const json = JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[] | string> } }
      const base = json.compilerOptions?.baseUrl ? resolve(repoRoot, json.compilerOptions.baseUrl) : repoRoot
      const paths = json.compilerOptions?.paths ?? {}
      for (const [k, v] of Object.entries(paths)) {
        const target = Array.isArray(v) ? v[0] : v
        if (typeof target !== 'string') continue
        const prefix = k.replace(/\*$/, '')
        const dir = target.replace(/\*$/, '').replace(/^\.\//, '')
        aliases.push({ prefix, dir: resolve(base, dir) })
      }
    } catch { /* */ }
  }

  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    try {
      const src = readFileSync(join(repoRoot, f), 'utf8')
      const re = /['"]([^'"\s]+)['"]\s*:\s*(?:[\w.]*resolve\([^,]*,\s*['"]([^'"]+)['"]\)|fileURLToPath\(\s*new URL\(\s*['"]([^'"]+)['"]|['"]([^'"]+)['"])/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const key = m[1]
        const dir = m[2] || m[3] || m[4]
        if (!key || !dir || key.startsWith('.')) continue
        aliases.push({ prefix: key, dir: resolve(repoRoot, dir.replace(/^\.\//, '')) })
      }
    } catch { /* */ }
  }

  // Default '@' → src when nothing else matched (very common).
  if (!aliases.some((a) => a.prefix === '@' || a.prefix === '@/')) {
    const srcDir = resolve(repoRoot, 'src')
    if (existsSync(srcDir)) aliases.push({ prefix: '@/', dir: srcDir })
  }
  return aliases
}

function resolveImport(fromAbs: string, spec: string, aliases: Alias[]): string | null {
  if (spec.startsWith('.')) return resolveFile(resolve(dirname(fromAbs), spec))
  for (const a of aliases) {
    const pfx = a.prefix.endsWith('/') ? a.prefix : a.prefix + '/'
    if (spec === a.prefix || spec.startsWith(pfx)) {
      const rest = spec === a.prefix ? '' : spec.slice(pfx.length)
      return resolveFile(rest ? join(a.dir, rest) : a.dir)
    }
  }
  return null // bare package import — skip
}

const IMPORT_RE = /(?:from\s*|import\s*|require\(\s*)['"]([^'"]+)['"]/g

function buildBundle(repoRoot: string, pageRel: string, styleRels: string[], aliases: Alias[]): string | null {
  const pageAbs = resolve(repoRoot, pageRel)
  const pageSrc = readFileCapped(pageAbs)
  if (!pageSrc) return null

  const parts: string[] = [`/* ===== PAGE: ${pageRel} ===== */\n${pageSrc}`]
  let bytes = parts[0].length

  const seen = new Set<string>([pageAbs])
  let imported = 0
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(pageSrc)) !== null && imported < MAX_IMPORTS_PER_PAGE) {
    const abs = resolveImport(pageAbs, m[1], aliases)
    if (!abs || seen.has(abs)) continue
    seen.add(abs)
    const src = readFileCapped(abs)
    if (!src) continue
    const header = `\n\n/* ===== IMPORT: ${m[1]} ===== */\n`
    if (bytes + header.length + src.length > MAX_BUNDLE_BYTES) break
    parts.push(header + src)
    bytes += header.length + src.length
    imported++
  }

  for (const rel of styleRels.slice(0, 3)) {
    const src = readFileCapped(resolve(repoRoot, rel))
    if (!src) continue
    const header = `\n\n/* ===== STYLES: ${rel} ===== */\n`
    if (bytes + header.length + src.length > MAX_BUNDLE_BYTES) break
    parts.push(header + src)
    bytes += header.length + src.length
  }

  return parts.join('')
}

export async function capturePageMockups(opts: CaptureOptions): Promise<CaptureResult> {
  const { repoRoot, baseUrl, bearer, sourceId, artifact } = opts
  const routes = Array.isArray(artifact.routes) ? artifact.routes : []
  const workflows = Array.isArray(artifact.workflows) ? artifact.workflows : []
  const styleRels = Array.isArray(artifact.designTokens?.source) ? artifact.designTokens!.source! : []
  const tokens = artifact.designTokens ?? null
  const framework = artifact.primaryFramework
  const aliases = loadAliases(repoRoot)

  const routeFile = (routePath: string): string | undefined =>
    routes.find((r) => r.path === routePath)?.file

  const items: RenderMockupItem[] = []
  workflows.forEach((wf, wi) => {
    const steps = Array.isArray(wf.steps) ? wf.steps : []
    steps.forEach((step, si) => {
      if (step?.kind !== 'page' || typeof step.route !== 'string') return
      const file = routeFile(step.route)
      if (!file) return
      const bundle = buildBundle(repoRoot, file, styleRels, aliases)
      if (!bundle) return
      items.push({ key: `${wi}:${si}`, sourceBundle: bundle, tokens, framework })
    })
  })

  if (items.length === 0) return { requested: 0, rendered: 0 }

  let rendered = 0
  try {
    const { results } = await renderMockups(baseUrl, bearer, sourceId, items)
    for (const r of results ?? []) {
      if (!r?.visualRef) continue
      const [wi, si] = r.key.split(':').map(Number)
      const step = workflows[wi]?.steps?.[si]
      if (step) { (step as Record<string, unknown>).visualRef = r.visualRef; rendered++ }
    }
  } catch { /* fail-soft — keep abstract nodes */ }

  return { requested: items.length, rendered }
}
