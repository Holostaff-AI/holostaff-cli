/**
 * Detect existing `holostaff.*` calls in customer source files —
 * Wave 2d. The returned structure plugs into the CLI's artifact
 * upload as `detectedInstrumentation` + `detectedIdentityInstrumentation`.
 *
 * Scope (Wave 2d + Wave 2-extended):
 *   - `.vue`, `.tsx`, `.jsx` files. Other extensions are skipped (the
 *     agent surfaces them as warnings — same boundary as Wave 2c's
 *     patcher). The regex patterns are framework-agnostic so the
 *     same scanner walks all three.
 *   - `holostaff.markStageEntry('STAGE')` and
 *     `holostaff.identify('USER')` / `holostaff.clearIdentity()` patterns.
 *   - `holostaff.emitSignal('NAME')` (signal name extraction). The
 *     server has no expected counterpart for these yet — they end up
 *     in `detected[]` until Wave 2b-extended produces declarations.
 *
 * File → workflow mapping:
 *   - markStageEntry: matched by the file path against each workflow's
 *     entryPage.file. A single file rarely entries more than one
 *     workflow; if it does, the call attaches to all matching workflows.
 *   - identify / clearIdentity: artifact-level (no workflow lookup).
 *
 * Why regex-based:
 *   The Wave 2c patcher itself is regex-based. Round-tripping with
 *   the same approach keeps the contract simple and avoids pulling
 *   in a Vue AST dep. Switching to @vue/compiler-sfc is straightforward
 *   when richer detection is needed.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import {
  type DetectionResult,
  type InstrumentationCallSite,
  type RouteLite,
  type WorkflowLite,
} from './instrumentationTypes.js'

export interface DetectInput {
  /** Repo root — file paths in workflows/routes are resolved from here. */
  repoRoot: string
  workflows: WorkflowLite[]
  /** Route → file map (from the artifact's routes[]). Used to find files. */
  routes: RouteLite[]
}

const STAGE_ENTRY_RE = /holostaff\.markStageEntry\(\s*['"]([a-z_]+)['"]\s*\)/g
const IDENTIFY_RE = /holostaff\.identify\(\s*([^)]*)\)/g
const CLEAR_IDENTITY_RE = /holostaff\.clearIdentity\(\s*\)/g
const EMIT_SIGNAL_RE = /holostaff\.emitSignal\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g

export function detectInstrumentation(input: DetectInput): DetectionResult {
  // Build entryPage-file → workflows index. A file may map to multiple
  // workflows (rare); preserve that.
  const fileToWorkflows = buildFileToWorkflowsIndex(input.workflows, input.routes)

  // Collect every candidate file: union of (a) all entryPage files for
  // workflows and (b) all routes' files. We also want any other .vue
  // files that may carry identify/clearIdentity — but Wave 2d's scope
  // is to look only at files we've already mapped. Identity-call
  // discovery in arbitrary files is Wave 2b-ext (the LLM-driven sign-in
  // detection pass). For now: scan the same file set the patcher
  // touches.
  const filesToScan = new Set<string>()
  for (const f of fileToWorkflows.keys()) filesToScan.add(f)
  for (const r of input.routes) if (r.file) filesToScan.add(r.file)

  const result: DetectionResult = {
    workflows: Object.fromEntries(input.workflows.map(w => [w.name, [] as InstrumentationCallSite[]])),
    identity: [],
    filesScanned: [],
  }

  for (const relPath of filesToScan) {
    if (!isScannableExtension(relPath)) continue
    const absPath = isAbsolute(relPath) ? relPath : join(input.repoRoot, relPath)
    if (!existsSync(absPath)) continue
    let content: string
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      continue
    }

    const calls = scanFile(content, relPath)
    result.filesScanned.push({ file: relPath, callsFound: calls.length })

    for (const call of calls) {
      if (call.kind === 'markStageEntry') {
        const workflows = fileToWorkflows.get(relPath) ?? []
        for (const wf of workflows) {
          // Only attribute to a workflow when the stage matches —
          // a file may host the entry for multiple workflows with
          // different stages; the call is unambiguous.
          if (call.stage && call.stage !== wf.bowtieStage) continue
          const bucket = result.workflows[wf.name] ?? []
          bucket.push({
            ...call,
            anchor: { kind: 'entry_page', route: matchingRoute(wf, relPath) ?? wf.entryPages[0]?.route ?? '/' },
          })
          result.workflows[wf.name] = bucket
        }
      } else if (call.kind === 'identify' || call.kind === 'clearIdentity') {
        result.identity.push(call)
      }
      // emitSignal: scoped out of Wave 2d's workflow bucketing. The CLI
      // can stash them under a special workflow id in a follow-up.
    }
  }

  return result
}

// -------------------------------------------------------------------------
// Per-file scan
// -------------------------------------------------------------------------

function scanFile(content: string, relPath: string): InstrumentationCallSite[] {
  const calls: InstrumentationCallSite[] = []
  const lines = content.split('\n')
  const lineOf = (matchIdx: number) => {
    let idx = 0
    for (let i = 0; i < lines.length; i++) {
      const next = idx + (lines[i]?.length ?? 0) + 1  // +1 for the newline
      if (matchIdx < next) return i + 1
      idx = next
    }
    return lines.length
  }

  for (const m of content.matchAll(STAGE_ENTRY_RE)) {
    calls.push({
      kind: 'markStageEntry',
      stage: m[1] as InstrumentationCallSite['stage'],
      anchor: { kind: 'entry_page', route: '' },  // route filled in by caller
      file: relPath,
      line: lineOf(m.index ?? 0),
    })
  }
  for (const m of content.matchAll(IDENTIFY_RE)) {
    calls.push({
      kind: 'identify',
      anchor: { kind: 'sign_in_complete' },
      file: relPath,
      line: lineOf(m.index ?? 0),
    })
  }
  for (const m of content.matchAll(CLEAR_IDENTITY_RE)) {
    calls.push({
      kind: 'clearIdentity',
      anchor: { kind: 'sign_out' },
      file: relPath,
      line: lineOf(m.index ?? 0),
    })
  }
  for (const m of content.matchAll(EMIT_SIGNAL_RE)) {
    calls.push({
      kind: 'emitSignal',
      signalName: m[1],
      anchor: { kind: 'custom_event' },
      file: relPath,
      line: lineOf(m.index ?? 0),
    })
  }
  return calls
}

// -------------------------------------------------------------------------
// File → workflow indexing
// -------------------------------------------------------------------------

function buildFileToWorkflowsIndex(
  workflows: WorkflowLite[],
  routes: RouteLite[],
): Map<string, WorkflowLite[]> {
  // Build route → file map first (some entry pages omit the file).
  const routeFile = new Map<string, string>()
  for (const r of routes) {
    if (r.file) routeFile.set(r.path, r.file)
  }

  const out = new Map<string, WorkflowLite[]>()
  for (const wf of workflows) {
    for (const ep of wf.entryPages) {
      const file = routeFile.get(ep.route)
      if (!file) continue
      const list = out.get(file) ?? []
      if (!list.some(w => w.name === wf.name)) list.push(wf)
      out.set(file, list)
    }
  }
  return out
}

function matchingRoute(wf: WorkflowLite, file: string): string | null {
  // Reverse-resolve: which of this workflow's entryPages is in this file?
  // Returns the first match; if none match, caller falls back to the
  // workflow's first entry.
  for (const ep of wf.entryPages) {
    if (ep.route && file.toLowerCase().includes(slugify(ep.route))) return ep.route
  }
  return null
}

function slugify(route: string): string {
  // '/pricing' → 'pricing'. Best-effort heuristic for file/route
  // similarity; '/' → '' (any file matches).
  return route.replace(/^\/+/, '').replace(/\//g, '-').toLowerCase()
}

function isScannableExtension(relPath: string): boolean {
  return relPath.endsWith('.vue') || relPath.endsWith('.tsx') || relPath.endsWith('.jsx')
}

export type { DetectionResult, WorkflowLite, RouteLite } from './instrumentationTypes.js'
