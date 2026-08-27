/**
 * `holostaff deploy --local` — write the deploy into this checkout.
 *
 * The server computes the same patch set it would push through the
 * Holostaff GitHub App (see deploy/api.ts LocalPlan); this module owns
 * everything that touches the engineer's working tree:
 *
 *   1. Clean-tree preflight (same rule as /instrument and /embed).
 *   2. `git checkout -B holostaff/deploy-v{N}` from the current HEAD.
 *      -B mirrors the App path, which fast-forwards an existing deploy
 *      branch to the base on repush.
 *   3. Write every create/edit from the plan + .holostaff/deploy-state.json.
 *   4. If a patched file imports `@holostaff/sdk` and the nearest
 *      package.json does not depend on it, add it and resolve the
 *      lockfile (no node_modules install).
 *   5. Commit. Any failure rolls the tree back to the branch it was on.
 *
 * Pushing and opening the PR are the caller's job (openPullRequest).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { SDK_DEP_VERSION } from '../agent/embed/embedPrompt.js'
import { dirtyTreeLines, syncLockfile } from '../instrument/applyPlan.js'
import type { LocalPlan, LocalPlanChange } from './api.js'

const exec = promisify(execFile)

export const DEPLOY_STATE_FILE = '.holostaff/deploy-state.json'

/**
 * Read the current contents of the repo paths the plan wants. Missing
 * files are simply absent from the result; the server reports them as
 * skipped (or creates them, for generated files).
 */
export function readLocalFiles(repoRoot: string, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of paths) {
    if (!p || p.startsWith('/') || p.split('/').includes('..')) continue
    const abs = join(repoRoot, p)
    if (!existsSync(abs)) continue
    try {
      out[p] = readFileSync(abs, 'utf8')
    } catch { /* unreadable: treat as missing */ }
  }
  return out
}

export type LocalApplyResult =
  | {
      ok: true
      branch: string
      sha: string
      filesChanged: string[]
      /** package.json files that gained `@holostaff/sdk`. */
      packageJsonsTouched: string[]
      lockfile: string | null
    }
  | { ok: false; step: 'preflight' | 'branch' | 'apply' | 'commit'; error: string }

export interface LocalApplyInput {
  repoRoot: string
  plan: LocalPlan
  onLog?: (line: string) => void
}

export async function applyLocalPlan(input: LocalApplyInput): Promise<LocalApplyResult> {
  const { repoRoot: cwd, plan } = input
  const log = input.onLog ?? (() => {})

  // 1) Clean tree.
  let dirty: string
  try {
    dirty = await dirtyTreeLines(cwd)
  } catch (err) {
    return { ok: false, step: 'preflight', error: `git status failed: ${(err as Error).message}. Is this a git repo?` }
  }
  if (dirty.length > 0) {
    return {
      ok: false,
      step: 'preflight',
      error: 'Working tree is not clean. `deploy --local` creates a branch and commits the instrumentation. '
        + `Commit or stash your changes first.\n${dirty}`,
    }
  }

  // 2) Branch.
  let previousRef: string
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    previousRef = stdout.trim()
    if (previousRef === 'HEAD') {
      const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD'], { cwd })
      previousRef = sha.trim()
    }
  } catch (err) {
    return { ok: false, step: 'branch', error: `git rev-parse failed: ${(err as Error).message}` }
  }
  if (previousRef === plan.branch) {
    return {
      ok: false,
      step: 'branch',
      error: `You are already on ${plan.branch}. Check out the branch you want the PR based on and re-run.`,
    }
  }
  try {
    await exec('git', ['checkout', '-B', plan.branch], { cwd })
    log(`· branch ${plan.branch}`)
  } catch (err) {
    return { ok: false, step: 'branch', error: `failed to create branch: ${(err as Error).message}` }
  }

  // 3) Files.
  const filesChanged: string[] = []
  const createdFiles: string[] = []
  const packageJsonsTouched: string[] = []
  let lockfile: string | null = null
  const rollbackAndFail = async (error: string): Promise<LocalApplyResult> => {
    await rollback(cwd, plan.branch, previousRef, createdFiles)
    return { ok: false, step: 'apply', error }
  }

  try {
    for (const change of plan.changes) {
      if (change.status !== 'create' && change.status !== 'edit') continue
      if (typeof change.content !== 'string') {
        throw new Error(`plan change for ${change.file} has no content`)
      }
      writeRepoFile(cwd, change.file, change.content, createdFiles)
      filesChanged.push(change.file)
      log(`· ${change.status === 'create' ? 'create' : 'edit'}   ${change.file}`)
    }
    writeRepoFile(cwd, DEPLOY_STATE_FILE, plan.deployStateJson, createdFiles)
    filesChanged.push(DEPLOY_STATE_FILE)
    log(`· write    ${DEPLOY_STATE_FILE}`)

    // 4) SDK dependency.
    for (const pkgPath of packageJsonsNeedingSdk(cwd, plan.changes)) {
      addSdkDependency(join(cwd, pkgPath))
      filesChanged.push(pkgPath)
      packageJsonsTouched.push(pkgPath)
      log(`· edit     ${pkgPath} (+ @holostaff/sdk ${SDK_DEP_VERSION})`)
    }
    if (packageJsonsTouched.length > 0) {
      log('· resolving lockfile')
      lockfile = await syncLockfile(cwd, undefined, () => {})
      if (lockfile) {
        filesChanged.push(lockfile)
        log(`· edit     ${lockfile}`)
      }
    }
  } catch (err) {
    return rollbackAndFail((err as Error).message)
  }

  // 5) Commit. The state file lives under .holostaff/, which scan
  // registers in .git/info/exclude; force-add exactly that one file
  // (never source.json, which stays local).
  try {
    const regular = filesChanged.filter((f) => f !== DEPLOY_STATE_FILE)
    if (regular.length > 0) await exec('git', ['add', '--', ...regular], { cwd })
    await exec('git', ['add', '-f', '--', DEPLOY_STATE_FILE], { cwd })
    await exec('git', ['commit', '-m', commitMessage(plan)], { cwd })
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd })
    const sha = stdout.trim()
    log(`✓ committed ${sha.slice(0, 7)} on ${plan.branch}`)
    return { ok: true, branch: plan.branch, sha, filesChanged, packageJsonsTouched, lockfile }
  } catch (err) {
    await rollback(cwd, plan.branch, previousRef, createdFiles)
    return { ok: false, step: 'commit', error: `commit failed: ${(err as Error).message}` }
  }
}

// ────────────────────────────────────────────────────────────────────────

function writeRepoFile(cwd: string, file: string, content: string, created: string[]): void {
  if (!file || file.startsWith('/') || file.split('/').includes('..')) {
    throw new Error(`refusing to write outside the repo: ${file}`)
  }
  const abs = join(cwd, file)
  if (!existsSync(abs)) created.push(file)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, { encoding: 'utf8' })
}

const SDK_IMPORT = /['"]@holostaff\/sdk['"]/

/**
 * Nearest package.json above each patched file that imports the SDK
 * and does not already depend on it. Repo-relative, de-duplicated.
 */
export function packageJsonsNeedingSdk(cwd: string, changes: LocalPlanChange[]): string[] {
  const out = new Set<string>()
  for (const c of changes) {
    if (c.status !== 'create' && c.status !== 'edit') continue
    if (!c.content || !SDK_IMPORT.test(c.content)) continue
    const pkg = nearestPackageJson(cwd, c.file)
    if (!pkg) continue
    if (hasSdkDependency(join(cwd, pkg))) continue
    out.add(pkg)
  }
  return [...out]
}

function nearestPackageJson(cwd: string, file: string): string | null {
  let dir = dirname(file)
  for (;;) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`
    if (existsSync(join(cwd, candidate))) return candidate
    if (dir === '.' || dir === '') return null
    const parent = dirname(dir)
    dir = parent === dir ? '.' : parent
  }
}

function hasSdkDependency(absPkgPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(absPkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (pkg[key] && typeof pkg[key] === 'object' && '@holostaff/sdk' in pkg[key]!) return true
    }
    return false
  } catch {
    // Unparseable package.json: leave it alone rather than rewrite it.
    return true
  }
}

/** Add `@holostaff/sdk` to dependencies, keeping the file's indentation. */
function addSdkDependency(absPkgPath: string): void {
  const raw = readFileSync(absPkgPath, 'utf8')
  const indent = /^\{\n(\s+)"/.exec(raw)?.[1] ?? '  '
  const pkg = JSON.parse(raw) as Record<string, unknown>
  const deps = (pkg.dependencies && typeof pkg.dependencies === 'object')
    ? pkg.dependencies as Record<string, string>
    : {}
  deps['@holostaff/sdk'] = SDK_DEP_VERSION
  pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(absPkgPath, `${JSON.stringify(pkg, null, indent)}\n`, { encoding: 'utf8' })
}

function commitMessage(plan: LocalPlan): string {
  const patched = plan.changes.filter((c) => c.status === 'create' || c.status === 'edit')
  return [
    `holostaff: deploy v${plan.artifactVersion}`,
    '',
    `Instrumentation for stage-aware copilots (${patched.length} file(s) + ${DEPLOY_STATE_FILE}).`,
    'Generated by `holostaff deploy --local`.',
  ].join('\n')
}

async function rollback(cwd: string, branch: string, previousRef: string, createdFiles: string[]): Promise<void> {
  try {
    await exec('git', ['checkout', '--', '.'], { cwd })
    for (const f of createdFiles) {
      try { unlinkSync(join(cwd, f)) } catch { /* already gone */ }
    }
    await exec('git', ['checkout', previousRef], { cwd })
    await exec('git', ['branch', '-D', branch], { cwd })
  } catch {
    /* best-effort: the error we return already tells the user what happened */
  }
}
