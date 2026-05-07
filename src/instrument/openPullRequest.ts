/**
 * openPullRequest — push a branch and open a PR via the `gh` CLI.
 *
 * Used by /instrument and /embed after applyPlan commits to a fresh
 * branch. The user gets a [Y]/[N] prompt before this runs — no
 * surprise pushes.
 *
 * Detection model:
 *   - `gh --version` succeeds → gh is installed.
 *   - `gh auth status` succeeds → gh is logged in to GitHub.
 *   - `git remote get-url origin` succeeds → we have somewhere to push.
 *
 * If any of those fail, we return a typed result the UI can surface as
 * "branch ready, push manually" — never crash the user's session.
 *
 * The PR body is intentionally short. Customers will edit it; our job
 * is to make the why obvious so reviewers don't have to context-switch.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type PrResult =
  | { kind: 'opened'; url: string; branch: string }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; step: 'push' | 'pr'; error: string }

export type SkipReason =
  | 'gh_missing'
  | 'gh_unauthed'
  | 'no_remote'

export interface OpenPrInput {
  cwd: string
  branch: string
  /** Title — kept under 70 chars at the call site. */
  title: string
  /** Body. Markdown. Will be passed via stdin to avoid shell quoting issues. */
  body: string
  /** Base branch the PR targets. Defaults to remote HEAD; falls back to 'main'. */
  base?: string
}

/** Run a child process, capturing stdout/stderr. Treats any exit ≠ 0 as failure. */
async function tryExec(file: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(file, args, { cwd })
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() }
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string }
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? e.message),
    }
  }
}

export async function checkPrPrerequisites(cwd: string): Promise<SkipReason | null> {
  const ghVersion = await tryExec('gh', ['--version'], cwd)
  if (!ghVersion.ok) return 'gh_missing'
  const ghAuth = await tryExec('gh', ['auth', 'status'], cwd)
  if (!ghAuth.ok) return 'gh_unauthed'
  const origin = await tryExec('git', ['remote', 'get-url', 'origin'], cwd)
  if (!origin.ok) return 'no_remote'
  return null
}

export async function openPullRequest(input: OpenPrInput): Promise<PrResult> {
  const skip = await checkPrPrerequisites(input.cwd)
  if (skip) return { kind: 'skipped', reason: skip }

  // Push the branch, setting upstream so subsequent pushes don't need -u.
  const push = await tryExec('git', ['push', '-u', 'origin', input.branch], input.cwd)
  if (!push.ok) {
    return { kind: 'failed', step: 'push', error: push.stderr.trim() || 'git push failed' }
  }

  // Pipe body via stdin → avoids brittle shell escaping for multiline content.
  const args = ['pr', 'create', '--title', input.title, '--body-file', '-']
  if (input.base) args.push('--base', input.base)

  try {
    const { stdout, stderr } = await execGhWithBody(input.cwd, args, input.body)
    // gh emits the PR URL on stdout. If it didn't, something's odd —
    // surface what we got so the user can recover.
    const url = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('https://'))
    if (!url) {
      return {
        kind: 'failed',
        step: 'pr',
        error: stderr.trim() || stdout.trim() || 'gh pr create did not return a URL',
      }
    }
    return { kind: 'opened', url, branch: input.branch }
  } catch (err) {
    return { kind: 'failed', step: 'pr', error: (err as Error).message }
  }
}

/**
 * Run `gh` with body content piped on stdin. Promisified execFile doesn't
 * expose stdin, so we drop down to spawn-style usage.
 */
function execGhWithBody(cwd: string, args: string[], body: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).toString().trim()))
        return
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
    child.stdin?.end(body)
  })
}
