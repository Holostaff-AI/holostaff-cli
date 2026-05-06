/**
 * Local credential storage. Lives at ~/.holostaff/credentials.json,
 * mode 0600 so other users on the machine can't read.
 *
 * Two paths read these credentials:
 *   1. Interactive runs — read at startup, branch on present/expired.
 *   2. Authenticated API calls — bearer token attached to requests.
 *
 * `HOLOSTAFF_API_KEY` env var, when set, takes precedence over the
 * file. CI users set the env var and never write a credentials file.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'

export interface Credentials {
  /** HMAC-JWT bearer token from /api/cli/auth/poll. */
  accessToken: string
  /** ISO expiry from the issuing server (server token TTL = 30 days). */
  expiresAt: string
  workspaceId: string
  userId: string
  /** Backend base URL (e.g. https://holostaff-vision-XXX.us-central1.run.app). */
  baseUrl: string
  /** When we wrote this file locally — used for diagnostic logging. */
  storedAt: string
}

const CREDS_DIR = join(homedir(), '.holostaff')
const CREDS_PATH = join(CREDS_DIR, 'credentials.json')

const ENV_API_KEY = 'HOLOSTAFF_API_KEY'
const ENV_WORKSPACE_ID = 'HOLOSTAFF_WORKSPACE_ID'
const ENV_BASE_URL = 'HOLOSTAFF_API_BASE_URL'

/**
 * Effective auth source for this run. Priority:
 *   1. env vars (CI mode) — `HOLOSTAFF_API_KEY` + `HOLOSTAFF_WORKSPACE_ID`
 *   2. file at ~/.holostaff/credentials.json
 *   3. null — unauthenticated; the UI prompts for login
 */
export interface ResolvedAuth {
  source: 'env' | 'file' | 'none'
  /** Bearer token to send. Undefined when source === 'none'. */
  token?: string
  /** Workspace this auth is bound to. Undefined when source === 'none'. */
  workspaceId?: string
  /** User identity if known (file source only — env source has no user). */
  userId?: string
  /** Effective backend base URL. */
  baseUrl: string
  /** True when source === 'file' and the stored token is past its expiry. */
  expired: boolean
}

const DEFAULT_BASE_URL = 'https://holostaff-vision-1008066443043.us-central1.run.app'

export function resolveAuth(): ResolvedAuth {
  const baseUrl = process.env[ENV_BASE_URL] || DEFAULT_BASE_URL

  // 1. Env-var (CI) path — wins outright.
  const envKey = process.env[ENV_API_KEY]
  if (envKey) {
    return {
      source: 'env',
      token: envKey,
      workspaceId: process.env[ENV_WORKSPACE_ID],
      baseUrl,
      expired: false,
    }
  }

  // 2. File path
  const file = readCredentials()
  if (file) {
    const expired = Date.parse(file.expiresAt) <= Date.now()
    return {
      source: 'file',
      token: file.accessToken,
      workspaceId: file.workspaceId,
      userId: file.userId,
      baseUrl: file.baseUrl,
      expired,
    }
  }

  return { source: 'none', baseUrl, expired: false }
}

export function readCredentials(): Credentials | null {
  if (!existsSync(CREDS_PATH)) return null
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf8')) as Credentials
  } catch {
    // Corrupt file — treat as missing. The user can re-login.
    return null
  }
}

export function writeCredentials(creds: Credentials): void {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8' })
  // Tighten file mode so other users can't read the token.
  try { chmodSync(CREDS_PATH, 0o600) } catch { /* best-effort on weird filesystems */ }
}

export function clearCredentials(): boolean {
  if (!existsSync(CREDS_PATH)) return false
  rmSync(CREDS_PATH, { force: true })
  return true
}

export function credentialsPath(): string {
  return CREDS_PATH
}
