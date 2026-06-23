/**
 * Derive the GitHub repo full name (`owner/repo`) from the local
 * checkout's `origin` remote. Wave 1f uses this to tell the server
 * which repo to open the PR against.
 *
 * Supports the two URL forms git always emits:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *
 * Returns null on any failure (no git, no origin, non-GitHub remote).
 * Caller surfaces the error to the user with a clear next step.
 */

import { execFileSync } from 'node:child_process'

export function detectGithubRepoFullName(repoRoot: string): string | null {
  let url: string
  try {
    url = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
  return parseGithubRemote(url)
}

/**
 * Stable repo-identity marker for a scanned product — `github.com/owner/repo`,
 * normalized so https and ssh remotes for the same repo produce the same
 * string. The server keys repo-identity dedup on this within a workspace, so a
 * teammate scanning the same repo converges onto one journey map. Returns
 * undefined when there's no git / no origin / a non-GitHub remote (no dedup,
 * same as before — the scan just creates a fresh source).
 */
export function detectRepoOrigin(repoRoot: string): string | undefined {
  const fullName = detectGithubRepoFullName(repoRoot)
  return fullName ? `github.com/${fullName}` : undefined
}

export function parseGithubRemote(url: string): string | null {
  if (!url) return null
  // https://github.com/owner/repo.git  or  https://github.com/owner/repo
  // ssh:    git@github.com:owner/repo.git
  // ssh:    ssh://git@github.com/owner/repo.git
  let m = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
  if (m) return `${m[1]}/${m[2]}`
  m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url)
  if (m) return `${m[1]}/${m[2]}`
  m = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
  if (m) return `${m[1]}/${m[2]}`
  return null
}
