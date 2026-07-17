/**
 * applyPlan — turns an InstrumentationPlan into actual files + a git
 * commit on a fresh branch.
 *
 * Safety model:
 *   1. Validate the working tree is git-clean before we touch anything.
 *      Mid-flow file writes on a dirty tree make rollback awkward.
 *   2. Resolve placeholders in edits/creates: <workspaceId> + <sourceId>
 *      get substituted with the bearer's workspace + the bound source.
 *   3. Verify edit ops are unique-anchor: oldText must appear EXACTLY
 *      ONCE in its file. Fail loudly if not — never apply a multi-match.
 *   4. Create a fresh branch (holostaff/instrument-<ts>), apply ops,
 *      stage + commit. Caller pushes / opens a PR.
 *
 * If anything fails midway, we rebase the branch back to its parent
 * and surface the error. The user's original branch is never modified.
 *
 * No node_modules install runs here, but when the plan edits a
 * package.json and the repo has a lockfile, we DO run a lockfile-only
 * resolve and commit the delta — otherwise every `npm ci` build (CI,
 * Docker) fails on the branch with "package.json and package-lock.json
 * are out of sync" (found by the deployment rig's documenso target).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

import type {
  CreateOp,
  EditOp,
  InstallOp,
  InstrumentOp,
  InstrumentationPlan,
} from '../agent/instrument/instrumentSchema.js'

const exec = promisify(execFile)

export type ApplyEvent =
  | { type: 'preflight' }
  | { type: 'tree_dirty'; details: string }
  | { type: 'branch_creating'; name: string }
  | { type: 'branch_created'; name: string }
  | { type: 'op_applying'; index: number; total: number; op: InstrumentOp }
  | { type: 'op_applied'; index: number }
  | { type: 'op_failed'; index: number; error: string }
  | { type: 'lockfile_syncing'; packageManager: 'npm' | 'pnpm' | 'yarn' }
  | { type: 'lockfile_synced'; lockfile: string }
  | { type: 'committing' }
  | { type: 'committed'; sha: string; branch: string }
  | { type: 'rolled_back' }
  | { type: 'failed'; error: string }

export type ApplyResult =
  | {
      ok: true
      branch: string
      sha: string
      filesChanged: string[]
      packagesToInstall: string[]
      packageManager?: 'npm' | 'pnpm' | 'yarn'
    }
  | {
      ok: false
      error: string
      step: 'preflight' | 'branch' | 'apply' | 'commit'
    }

export interface ApplyOptions {
  cwd: string
  plan: InstrumentationPlan
  workspaceId: string
  sourceId: string
  /**
   * When set, substitutes the literal `REPLACE_WITH_COPILOT_ID` in plan
   * ops with this id. Used by /embed once the user has picked a copilot;
   * /instrument leaves it unset (it doesn't deal with copilot ids).
   */
  copilotId?: string
  onEvent?: (ev: ApplyEvent) => void
}

export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  const { cwd, plan, workspaceId, sourceId, copilotId, onEvent } = options
  const emit = onEvent ?? (() => {})

  // 1) Preflight — clean tree.
  emit({ type: 'preflight' })
  try {
    const { stdout: rawStatus } = await exec('git', ['status', '--porcelain'], { cwd })
    // Our own state dir (.holostaff/source.json, written by scan) must
    // never count as customer dirt — on repos that don't gitignore it,
    // scan → embed would always fail this preflight.
    const stdout = rawStatus
      .split('\n')
      .filter((l) => l.trim().length > 0 && !/^..\s+(")?\.holostaff\//.test(l))
      .join('\n')
    if (stdout.trim().length > 0) {
      emit({ type: 'tree_dirty', details: stdout.trim() })
      return {
        ok: false,
        step: 'preflight',
        error:
          'Working tree is not clean. /instrument creates a branch and commits the proposed edits — please commit or stash your changes first.',
      }
    }
  } catch (err) {
    return {
      ok: false,
      step: 'preflight',
      error: `git status failed: ${(err as Error).message}. Is this a git repo?`,
    }
  }

  // 2) Create branch.
  const branch = `holostaff/instrument-${stamp()}`
  emit({ type: 'branch_creating', name: branch })
  try {
    await exec('git', ['checkout', '-b', branch], { cwd })
    emit({ type: 'branch_created', name: branch })
  } catch (err) {
    return {
      ok: false,
      step: 'branch',
      error: `failed to create branch: ${(err as Error).message}`,
    }
  }

  // 3) Apply ops in order. Substitute placeholders + verify anchors.
  const filesChanged: string[] = []
  const packagesToInstall: string[] = []
  let packageManager: 'npm' | 'pnpm' | 'yarn' | undefined

  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i]!
    emit({ type: 'op_applying', index: i, total: plan.ops.length, op })
    try {
      switch (op.kind) {
        case 'install':
          packagesToInstall.push(...op.packages)
          packageManager = op.packageManager
          break
        case 'create':
          await applyCreate(cwd, op, workspaceId, sourceId, copilotId)
          filesChanged.push(op.file)
          break
        case 'edit':
          await applyEdit(cwd, op, workspaceId, sourceId, copilotId)
          filesChanged.push(op.file)
          break
      }
      emit({ type: 'op_applied', index: i })
    } catch (err) {
      const error = (err as Error).message
      emit({ type: 'op_failed', index: i, error })
      // Roll the branch back: checkout main (or whatever was the parent)
      // and delete the failed branch. Customer keeps a clean tree.
      const rolled = await rollback(cwd, branch)
      if (rolled) emit({ type: 'rolled_back' })
      return { ok: false, step: 'apply', error }
    }
  }

  // 3b) Lockfile sync — a package.json edit without a matching lockfile
  // update breaks every `npm ci`-style build of the branch. Resolve the
  // lockfile (no node_modules install) and ship it in the same commit.
  const touchedPackageJson = filesChanged.some((f) => f === 'package.json' || f.endsWith('/package.json'))
  if (touchedPackageJson) {
    try {
      const lockfile = await syncLockfile(cwd, packageManager, emit)
      if (lockfile) filesChanged.push(lockfile)
    } catch (err) {
      const error = `lockfile sync failed: ${(err as Error).message}`
      emit({ type: 'op_failed', index: plan.ops.length, error })
      const rolled = await rollback(cwd, branch)
      if (rolled) emit({ type: 'rolled_back' })
      return { ok: false, step: 'apply', error }
    }
  }

  // 4) Commit. There's nothing to commit if the only ops were install
  // (package manager runs writes to package.json + lockfile, but we
  // haven't run the install yet — v1 simplification). We still create
  // a "WIP" commit with a placeholder note in that case so the branch
  // exists and the user has a starting point.
  emit({ type: 'committing' })
  try {
    if (filesChanged.length > 0) {
      await exec('git', ['add', ...filesChanged], { cwd })
    }
    const message = composeCommitMessage(plan, packagesToInstall, packageManager)
    if (filesChanged.length === 0) {
      // No file edits — only install ops. Commit an empty marker so
      // the branch + message exist; user follows up with the install
      // command surfaced in the result message.
      await exec('git', ['commit', '--allow-empty', '-m', message], { cwd })
    } else {
      await exec('git', ['commit', '-m', message], { cwd })
    }
    const { stdout: shaOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd })
    const sha = shaOut.trim()
    emit({ type: 'committed', sha, branch })
    return {
      ok: true,
      branch,
      sha,
      filesChanged,
      packagesToInstall,
      packageManager,
    }
  } catch (err) {
    const error = `commit failed: ${(err as Error).message}`
    emit({ type: 'failed', error })
    return { ok: false, step: 'commit', error }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Op application
// ────────────────────────────────────────────────────────────────────────

function substitute(text: string, workspaceId: string, sourceId: string, copilotId?: string): string {
  let out = text.replace(/<workspaceId>/g, workspaceId).replace(/<sourceId>/g, sourceId)
  if (copilotId) {
    // The /embed agent emits the literal placeholder; we swap it for
    // the user-picked id at apply time so the customer doesn't have to
    // edit the diff before pushing.
    out = out.replace(/REPLACE_WITH_COPILOT_ID/g, copilotId)
  }
  return out
}

async function applyCreate(
  cwd: string,
  op: CreateOp,
  workspaceId: string,
  sourceId: string,
  copilotId?: string,
): Promise<void> {
  const target = join(cwd, op.file)
  if (existsSync(target)) {
    throw new Error(`create op refused: ${op.file} already exists`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, substitute(op.content, workspaceId, sourceId, copilotId), { encoding: 'utf8' })
}

async function applyEdit(
  cwd: string,
  op: EditOp,
  workspaceId: string,
  sourceId: string,
  copilotId?: string,
): Promise<void> {
  const target = join(cwd, op.file)
  if (!existsSync(target)) {
    throw new Error(`edit op failed: ${op.file} does not exist`)
  }
  const original = readFileSync(target, 'utf8')
  const oldText = substitute(op.oldText, workspaceId, sourceId, copilotId)
  const occurrences = countOccurrences(original, oldText)
  if (occurrences === 0) {
    throw new Error(`edit op failed: oldText not found in ${op.file}`)
  }
  if (occurrences > 1) {
    throw new Error(
      `edit op failed: oldText is not unique in ${op.file} (${occurrences} matches). Agent must propose a more specific anchor.`,
    )
  }
  const newText = substitute(op.newText, workspaceId, sourceId, copilotId)
  const next = original.replace(oldText, newText)
  writeFileSync(target, next, { encoding: 'utf8' })
}

/**
 * Bring the repo's lockfile in line with the (just-edited) package.json
 * without installing node_modules. Returns the repo-relative lockfile
 * path when one was resolved, null when the repo has no lockfile for
 * the detected package manager. Throws on resolver failure — a branch
 * with a stale lockfile is worse than a failed apply.
 */
async function syncLockfile(
  cwd: string,
  declared: 'npm' | 'pnpm' | 'yarn' | undefined,
  emit: (ev: ApplyEvent) => void,
): Promise<string | null> {
  // Trust the lockfile on disk over the plan's declared manager — the
  // agent guesses, the filesystem knows.
  const candidates: Array<{ pm: 'npm' | 'pnpm' | 'yarn'; lockfile: string; args: string[] }> = [
    { pm: 'npm', lockfile: 'package-lock.json', args: ['install', '--package-lock-only', '--ignore-scripts'] },
    { pm: 'pnpm', lockfile: 'pnpm-lock.yaml', args: ['install', '--lockfile-only', '--ignore-scripts'] },
    { pm: 'yarn', lockfile: 'yarn.lock', args: ['install', '--mode', 'update-lockfile'] },
  ]
  const present = candidates.filter((c) => existsSync(join(cwd, c.lockfile)))
  const chosen = present.find((c) => c.pm === declared) ?? present[0]
  if (!chosen) return null
  emit({ type: 'lockfile_syncing', packageManager: chosen.pm })
  // Match the repo's pinned manager version (package.json packageManager)
  // — lockfiles are version-sensitive (a pnpm 9 rewrite of a pnpm 11
  // lockfile fails the repo's own --frozen-lockfile with
  // ERR_PNPM_LOCKFILE_CONFIG_MISMATCH: deployment-rig formbricks
  // finding). npx pins the exact version; fall back to the global tool.
  let cmd: string = chosen.pm
  let args = chosen.args
  try {
    const rootPkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { packageManager?: string }
    const m = rootPkg.packageManager?.match(/^(npm|pnpm|yarn)@([\w.-]+)/)
    if (m && m[1] === chosen.pm) {
      cmd = 'npx'
      args = ['-y', `${m[1]}@${m[2]}`, ...chosen.args]
    }
  } catch { /* no readable root package.json — use the global tool */ }
  await exec(cmd, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
  emit({ type: 'lockfile_synced', lockfile: chosen.lockfile })
  return chosen.lockfile
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

// ────────────────────────────────────────────────────────────────────────
// Branch rollback (best-effort; surface but never re-throw)
// ────────────────────────────────────────────────────────────────────────

async function rollback(cwd: string, branch: string): Promise<boolean> {
  try {
    // Reset any working-tree changes our applies made; we haven't
    // committed yet so this won't lose user work.
    await exec('git', ['checkout', '.'], { cwd })
    // Move off the branch (try main, fall back to master, then HEAD~).
    try {
      await exec('git', ['checkout', '-'], { cwd })
    } catch {
      try {
        await exec('git', ['checkout', 'main'], { cwd })
      } catch {
        await exec('git', ['checkout', 'master'], { cwd })
      }
    }
    await exec('git', ['branch', '-D', branch], { cwd })
    return true
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
}

function composeCommitMessage(
  plan: InstrumentationPlan,
  packages: string[],
  pm: 'npm' | 'pnpm' | 'yarn' | undefined,
): string {
  const lines = [
    'feat(holostaff): wire @holostaff/sdk tracking',
    '',
    plan.summary,
  ]
  if (packages.length > 0 && pm) {
    lines.push('')
    lines.push(`Run after pulling this branch:`)
    lines.push(`  ${pm} ${pm === 'yarn' ? 'add' : 'install'} ${packages.join(' ')}`)
  }
  if (plan.coverageGaps.length > 0) {
    lines.push('')
    lines.push('Coverage gaps the agent flagged:')
    for (const g of plan.coverageGaps) lines.push(`- ${g}`)
  }
  lines.push('')
  lines.push('Generated by `holostaff /instrument`.')
  return lines.join('\n')
}

/**
 * Resolve a repo-relative path for display, given an absolute one.
 * Used in events sent to the UI.
 */
export function relPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  return rel.startsWith('..') ? abs : rel
}
