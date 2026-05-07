/**
 * Telemetry — anonymous, opt-out event emission to /api/cli/telemetry.
 *
 * What we send (per PRD §8): cli_version, os, node_version, command,
 * duration_ms, outcome, error_kind, framework_detected, repo_size_bucket,
 * sha256(workspace_id), session_id. Never source code, never file paths,
 * never the raw workspace id.
 *
 * Opt-out: HOLOSTAFF_TELEMETRY=0 disables. We surface this in the
 * README + --help.
 *
 * Fire-and-forget: failures are swallowed. Telemetry should never crash
 * the user's command. The endpoint accepts unauthenticated POSTs (no
 * bearer required) — rate limiting is upstream.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAuth } from './auth/credentials.js'

export type TelemetryCommand =
  | 'scan'
  | 'scan_ci'
  | 'refine'
  | 'instrument'
  | 'embed'
  | 'login'
  | 'chat'

export type TelemetryOutcome = 'success' | 'error' | 'canceled'

export type RepoSizeBucket = 'small' | 'medium' | 'large'

export interface TelemetryEventInput {
  command: TelemetryCommand
  outcome: TelemetryOutcome
  durationMs?: number
  /** Typed error category (auth_expired, agent_timeout, etc.). Free-form for now. */
  errorKind?: string
  /** e.g. 'vue3', 'react', 'next' */
  frameworkDetected?: string
  /** Bucketed by source file count: small <100, medium <1000, large else. */
  repoSizeBucket?: RepoSizeBucket
}

const EVENT_ENDPOINT = '/api/cli/telemetry'

/**
 * Stable per-CLI-invocation id. Lazily generated on first emit so cold
 * invocations that never emit don't burn a uuid.
 */
let _sessionId: string | undefined
function sessionId(): string {
  if (!_sessionId) _sessionId = randomUUID()
  return _sessionId
}

/**
 * Returns the CLI version from the package's own package.json. Cached
 * because read-on-each-emit would be wasteful — version doesn't change
 * mid-process.
 */
let _cliVersion: string | undefined
function cliVersion(): string {
  if (_cliVersion !== undefined) return _cliVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    _cliVersion = String(pkg.version ?? '0.0.0')
  } catch {
    _cliVersion = '0.0.0'
  }
  return _cliVersion
}

/** SHA-256 hex of the input — used to anonymise the workspace id before send. */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Decide the repo size bucket from a source-file count. Cheap heuristic.
 * Caller passes the count; we return undefined if it doesn't have one.
 */
export function bucketSize(sourceFileCount: number | undefined): RepoSizeBucket | undefined {
  if (typeof sourceFileCount !== 'number') return undefined
  if (sourceFileCount < 100) return 'small'
  if (sourceFileCount < 1000) return 'medium'
  return 'large'
}

function isDisabled(): boolean {
  const v = process.env.HOLOSTAFF_TELEMETRY
  return v === '0' || v === 'false' || v === 'off'
}

/**
 * Fire a telemetry event. Returns immediately — the actual POST runs
 * in the background and any failure is swallowed.
 *
 * The function is intentionally synchronous from the caller's view; we
 * don't await the network in critical paths because telemetry latency
 * shouldn't block the user.
 */
export function emit(input: TelemetryEventInput): void {
  if (isDisabled()) return

  const auth = resolveAuth()
  // Don't even attempt to emit if there's no workspace id — pre-auth
  // events would be unidentifiable anyway, and we'd rather drop them
  // than blanket-hash 'unknown'.
  if (!auth.workspaceId) return

  const body = {
    sessionId: sessionId(),
    workspaceIdHash: sha256(auth.workspaceId),
    cliVersion: cliVersion(),
    os: process.platform,
    nodeVersion: process.version,
    command: input.command,
    outcome: input.outcome,
    durationMs: input.durationMs,
    errorKind: input.errorKind,
    frameworkDetected: input.frameworkDetected,
    repoSizeBucket: input.repoSizeBucket,
  }

  // Fire-and-forget. We don't keep a pending-promise registry — if the
  // process exits mid-flight, the event is lost; that's acceptable for
  // anonymous telemetry.
  fetch(`${auth.baseUrl}${EVENT_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* swallow */ })
}
