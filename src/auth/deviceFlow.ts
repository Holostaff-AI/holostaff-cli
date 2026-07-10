/**
 * Device-flow orchestrator. Yields progress events so the Ink UI
 * can render each step transparently (PRD §4.0 — agent always names
 * what it's doing).
 *
 * The flow:
 *   1. POST /auth/start          → emit 'started'
 *   2. open the verification URI → emit 'browser_opened' or 'browser_fallback'
 *   3. poll /auth/poll/:state    → emit 'polling' periodically
 *   4. on approved               → emit 'approved' + persist credentials
 *   5. on denied/expired/timeout → emit 'failed'
 *
 * Cancellable via the returned `cancel()` function so the user can
 * Ctrl-C cleanly.
 */

import { startDeviceFlow, pollDeviceFlow } from './api.js'
import { openUrl } from './openBrowser.js'
import { writeCredentials } from './credentials.js'

export type FlowEvent =
  | { type: 'started'; verificationUri: string; code: string; expiresAt: string }
  | { type: 'browser_opened' }
  | { type: 'browser_fallback' }
  | { type: 'polling'; secondsElapsed: number }
  | { type: 'approved'; userId: string; workspaceId: string; expiresAt: string }
  | { type: 'failed'; reason: string; kind: 'denied' | 'expired' | 'timeout' | 'consumed' | 'network' | 'unknown' }

export interface DeviceFlowHandle {
  cancel(): void
  promise: Promise<void>
}

export interface DeviceFlowOpts {
  baseUrl: string
  /**
   * Repo (or owner/repo) the CLI is running in. New accounts get their
   * workspace auto-named from it server-side.
   */
  repoName?: string
  /** Default 5min. */
  totalTimeoutMs?: number
  /** Default the server-suggested interval. */
  pollIntervalMs?: number
  /** Skip opening the browser (e.g. when the test wants to do it manually). */
  skipOpen?: boolean
  onEvent: (e: FlowEvent) => void
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS_FALLBACK = 2_000

export function runDeviceFlow(opts: DeviceFlowOpts): DeviceFlowHandle {
  let cancelled = false
  const cancel = () => { cancelled = true }

  const promise = (async () => {
    const startedAt = Date.now()
    const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TIMEOUT_MS

    // ─── 1. Start the flow ────────────────────────────────────────
    let start
    try {
      start = await startDeviceFlow(opts.baseUrl, opts.repoName)
    } catch (err) {
      opts.onEvent({
        type: 'failed',
        kind: 'network',
        reason: `couldn't reach Holostaff: ${(err as Error).message}`,
      })
      return
    }

    opts.onEvent({
      type: 'started',
      verificationUri: start.verificationUri,
      code: start.code,
      expiresAt: start.expiresAt,
    })

    if (cancelled) return

    // ─── 2. Open browser ──────────────────────────────────────────
    if (!opts.skipOpen) {
      const r = await openUrl(start.verificationUri)
      opts.onEvent({ type: r === 'opened' ? 'browser_opened' : 'browser_fallback' })
    } else {
      opts.onEvent({ type: 'browser_fallback' })
    }

    if (cancelled) return

    // ─── 3. Poll until approved / failed / timeout ───────────────
    const intervalMs = opts.pollIntervalMs ?? ((start.pollIntervalSec * 1_000) || POLL_INTERVAL_MS_FALLBACK)
    let pollCount = 0

    while (!cancelled) {
      const elapsed = Date.now() - startedAt
      if (elapsed >= totalTimeoutMs) {
        opts.onEvent({
          type: 'failed',
          kind: 'timeout',
          reason: `no response after ${Math.round(totalTimeoutMs / 1000)}s — please try again.`,
        })
        return
      }

      // Wait first so we don't hammer right after /start
      await sleep(intervalMs, () => cancelled)
      if (cancelled) return

      pollCount += 1
      opts.onEvent({ type: 'polling', secondsElapsed: Math.round((Date.now() - startedAt) / 1000) })

      let result
      try {
        result = await pollDeviceFlow(opts.baseUrl, start.state)
      } catch {
        // Transient — keep polling rather than fail the flow.
        continue
      }

      switch (result.status) {
        case 'pending': continue
        case 'approved': {
          writeCredentials({
            accessToken: result.accessToken,
            userId: result.userId,
            workspaceId: result.workspaceId,
            expiresAt: result.expiresAt,
            baseUrl: opts.baseUrl,
            storedAt: new Date().toISOString(),
          })
          opts.onEvent({
            type: 'approved',
            userId: result.userId,
            workspaceId: result.workspaceId,
            expiresAt: result.expiresAt,
          })
          return
        }
        case 'denied':
          opts.onEvent({ type: 'failed', kind: 'denied', reason: 'login was denied in the browser.' })
          return
        case 'expired':
          opts.onEvent({ type: 'failed', kind: 'expired', reason: 'the code expired before authorisation. Try /login again.' })
          return
        case 'consumed':
          opts.onEvent({ type: 'failed', kind: 'consumed', reason: 'this code was already used. Try /login again.' })
          return
        case 'unknown':
          opts.onEvent({ type: 'failed', kind: 'unknown', reason: 'the auth state was lost. Try /login again.' })
          return
      }

      // Suppress unused warning for pollCount (kept for future telemetry)
      void pollCount
    }
  })()

  return { cancel, promise }
}

function sleep(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (isCancelled()) return resolve()
      if (Date.now() - start >= ms) return resolve()
      setTimeout(tick, Math.min(100, ms - (Date.now() - start)))
    }
    tick()
  })
}
