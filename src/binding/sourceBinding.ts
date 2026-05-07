/**
 * Per-repo source binding — `.holostaff/source.json`.
 *
 * Records which Holostaff knowledge source this repository's scans
 * map to. Written after the first successful upload so subsequent
 * scans find the same source instead of creating a fresh one each run.
 *
 * Layout:
 *   {
 *     "sourceId":   "ks_abc123_xy",
 *     "name":       "TutorLM",
 *     "workspaceId": "workspace_KcoPi0...",
 *     "createdAt":  "2026-05-06T12:34:56.000Z"
 *   }
 *
 * The file is per-repo, lives at <repoRoot>/.holostaff/source.json, and
 * is meant to be gitignored (we tell the user during the first upload).
 * If a teammate scans the same repo on a fresh checkout without the
 * file, they'll create a *new* source — that's fine for v1; multi-user
 * shared bindings land alongside Settings/CLI keys (B3).
 *
 * Mismatched workspaceId is a real footgun: a user logged into
 * workspace A scans a repo whose binding points at workspace B's
 * source. We detect that and refuse to use the binding rather than
 * fail confusingly mid-upload.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SourceBinding {
  sourceId: string
  name: string
  workspaceId: string
  createdAt: string
}

export type ReadResult =
  | { kind: 'found'; binding: SourceBinding }
  | { kind: 'missing' }
  | { kind: 'wrong_workspace'; binding: SourceBinding; expectedWorkspaceId: string }
  | { kind: 'malformed'; error: string }

export function bindingPath(repoRoot: string): string {
  return join(repoRoot, '.holostaff', 'source.json')
}

export function readBinding(repoRoot: string, currentWorkspaceId: string): ReadResult {
  const file = bindingPath(repoRoot)
  if (!existsSync(file)) return { kind: 'missing' }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { kind: 'malformed', error: (err as Error).message }
  }

  let parsed: Partial<SourceBinding>
  try {
    parsed = JSON.parse(raw) as Partial<SourceBinding>
  } catch (err) {
    return { kind: 'malformed', error: `invalid JSON: ${(err as Error).message}` }
  }

  if (!parsed.sourceId || !parsed.name || !parsed.workspaceId || !parsed.createdAt) {
    return { kind: 'malformed', error: 'missing required fields (sourceId/name/workspaceId/createdAt)' }
  }

  const binding = parsed as SourceBinding

  if (binding.workspaceId !== currentWorkspaceId) {
    return { kind: 'wrong_workspace', binding, expectedWorkspaceId: currentWorkspaceId }
  }
  return { kind: 'found', binding }
}

export function writeBinding(repoRoot: string, binding: SourceBinding): void {
  const file = bindingPath(repoRoot)
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(binding, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 })
}
