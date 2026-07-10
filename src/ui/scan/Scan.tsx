/**
 * Scan — top-level Ink view orchestrating /scan.
 *
 * State machine:
 *
 *   preflight  → check env + cwd before kicking off the agent
 *   running    → runScan() in flight; ScanProgress shows live events
 *   trust      → scan succeeded; TrustReport awaits user decision
 *   uploading  → user said yes; A2.5 will land the actual upload —
 *                today this stub displays a "would upload" notice
 *                so the flow is observable end-to-end
 *   saved      → user said save-locally; we wrote the artifact to
 *                .holostaff/scan-<timestamp>.json
 *   cancelled  → user said no, or scan was aborted
 *   failed     → scan errored (preflight or runScan reason !== ok)
 *
 * onExit fires once after a terminal state renders, giving the parent
 * (App) a beat to show the resolution before useApp().exit() runs.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { runScan, buildAgentEnv, type ScanEvent, type ScanResult } from '../../agent/runScan.js'
import type { ScanFindings } from '../../agent/findingsSchema.js'
import { mapFindingsToUpload, type CliArtifactUpload } from '../../agent/mapToArtifact.js'
import { uploadFlow, type UploadEvent, type UploadResult } from '../../agent/uploadArtifact.js'
import { detectGithubRepoFullName, detectRepoOrigin } from '../../deploy/gitRepo.js'
import { resolveAuth } from '../../auth/credentials.js'
import { postScanStatus } from '../../auth/scanStatus.js'
import { emit, classifyError } from '../../telemetry.js'
import { ScanProgress, reduceScanEvent, initialProgress, type ScanProgressState } from './ScanProgress.js'
import { SourcePicker } from './SourcePicker.js'
import { TrustReport } from './TrustReport.js'
import { UploadProgress, type UploadPhase } from './UploadProgress.js'

type Phase =
  | { kind: 'preflight' }
  // Pre-scan source picker, only shown when mergeMode='append'.
  | { kind: 'picking_source' }
  | { kind: 'running'; progress: ScanProgressState }
  | { kind: 'trust'; result: SuccessResult }
  | { kind: 'uploading'; result: SuccessResult; upload: CliArtifactUpload; uploadPhase: UploadPhase }
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

interface SuccessResult {
  findings: ScanFindings
  durationMs: number
  tokens: { input: number; output: number }
  sessionId: string | undefined
}

/**
 * Outcome the parent gets when the user backs out of (or finishes) the
 * scan flow. The shell uses this to render a one-line summary in
 * scrollback when it remounts.
 */
export type ScanExitResult =
  | { kind: 'uploaded'; sourceId: string; sourceName: string; version: number; viewUrl: string }
  | { kind: 'saved_local'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

export interface ScanProps {
  cwd: string
  /**
   * 'replace' (default): scan + upload as a fresh artifact / new
   * source. 'append': scan + merge findings into a user-picked
   * existing source (--add-repo).
   */
  mergeMode?: 'replace' | 'append'
  onExit: (result?: ScanExitResult) => void
}

/** One short line of live scan telemetry for the dashboard strip. */
function scanDetailLine(p: ScanProgressState): string {
  const parts = [`${p.filesRead} files read`]
  if (p.routesPreview > 0) parts.push(`${p.routesPreview} routes found`)
  if (p.componentsPreview > 0) parts.push(`${p.componentsPreview} components mapped`)
  return parts.join(' · ')
}

export function Scan({ cwd, mergeMode = 'replace', onExit }: ScanProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' })
  const [pickedSource, setPickedSource] = useState<{ sourceId: string; sourceName: string } | undefined>(
    undefined,
  )

  // Guard against double-fire: useEffect can run twice in dev/strict mode,
  // and the agent SDK is heavy — we only want one runScan per mount.
  const scanStartedRef = useRef(false)
  const startedAtRef = useRef(Date.now())
  const telemetryEmittedRef = useRef(false)

  // Initial mount: decide between picker (append + no pick yet) and scan.
  useEffect(() => {
    if (mergeMode === 'append' && !pickedSource) {
      setPhase({ kind: 'picking_source' })
      return
    }
    void startScan()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeMode, pickedSource])

  async function startScan() {
    if (scanStartedRef.current) return
    scanStartedRef.current = true

    // Let the dashboard's home hub flip to "scan in progress" live.
    postScanStatus({
      phase: 'started',
      repoName: detectGithubRepoFullName(cwd) ?? basename(cwd),
    })

    const env = await buildAgentEnv()
    if (!env) {
      setPhase({
        kind: 'failed',
        error:
          'Couldn\'t resolve model credentials. Sign in (`/login`) so the CLI can mint a session, or set AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY for BYO-key dev mode.',
      })
      return
    }

    // Drive the scan and reduce events into progress state.
    let progress = { ...initialProgress }
    let lastTelemetryAt = 0
    setPhase({ kind: 'running', progress })

    runScan({
      cwd,
      env,
      onEvent: (ev: ScanEvent) => {
        progress = reduceScanEvent(progress, ev)
        setPhase({ kind: 'running', progress })
        // Throttled live telemetry for the dashboard's mission control:
        // the browser strip shows what the scan is actually finding.
        const now = Date.now()
        if (now - lastTelemetryAt > 20_000) {
          lastTelemetryAt = now
          postScanStatus({ phase: 'started', detail: scanDetailLine(progress) })
        }
      },
    }).then((result: ScanResult) => {
      if (!result.ok) {
        setPhase({
          kind: 'failed',
          error: `${result.reason}: ${result.error}`,
        })
        return
      }
      setPhase({
        kind: 'trust',
        result: {
          findings: result.findings,
          durationMs: result.durationMs,
          tokens: result.tokens,
          sessionId: result.sessionId,
        },
      })
    })
  }

  // Exit a beat after a terminal state renders so the user sees it.
  // Upload is terminal only once its inner phase reaches 'done'; the
  // delay then is longer because the success message includes a URL
  // the user may want to click.
  useEffect(() => {
    if (phase.kind === 'cancelled') {
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({ command: 'scan', outcome: 'canceled', durationMs: Date.now() - startedAtRef.current })
        postScanStatus({ phase: 'failed', detail: 'cancelled' })
      }
      const t = setTimeout(() => onExit({ kind: 'cancelled' }), 1200)
      return () => clearTimeout(t)
    }
    if (phase.kind === 'failed') {
      const error = phase.error
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({
          command: 'scan',
          outcome: 'error',
          durationMs: Date.now() - startedAtRef.current,
          errorKind: classifyError(error),
        })
        postScanStatus({ phase: 'failed', detail: classifyError(error) })
      }
      const t = setTimeout(() => onExit({ kind: 'failed', error }), 1200)
      return () => clearTimeout(t)
    }
    if (phase.kind === 'saved') {
      const path = phase.path
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({ command: 'scan', outcome: 'success', durationMs: Date.now() - startedAtRef.current })
        postScanStatus({ phase: 'done', detail: 'saved locally (not uploaded)' })
      }
      const t = setTimeout(() => onExit({ kind: 'saved_local', path }), 1200)
      return () => clearTimeout(t)
    }
    if (phase.kind === 'uploading' && phase.uploadPhase.kind === 'done') {
      const r = phase.uploadPhase.result
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({
          command: 'scan',
          outcome: r.ok ? 'success' : 'error',
          durationMs: Date.now() - startedAtRef.current,
          errorKind: r.ok ? undefined : classifyError(r.error),
        })
        postScanStatus(r.ok ? { phase: 'done' } : { phase: 'failed', detail: classifyError(r.error) })
      }
      const out: ScanExitResult = r.ok
        ? {
            kind: 'uploaded',
            sourceId: r.sourceId,
            sourceName: r.sourceName,
            version: r.version,
            viewUrl: r.viewUrl,
          }
        : { kind: 'failed', error: r.error }
      const t = setTimeout(() => onExit(out), 2500)
      return () => clearTimeout(t)
    }
  }, [phase, onExit])

  // Build the upload payload eagerly when we hit trust, so confirm is instant.
  const upload =
    phase.kind === 'trust'
      ? mapFindingsToUpload({ findings: phase.result.findings, cliSessionId: phase.result.sessionId })
      : phase.kind === 'uploading'
        ? phase.upload
        : null

  switch (phase.kind) {
    case 'preflight':
      return <Centered>Preparing to scan {cwd}…</Centered>

    case 'picking_source':
      return (
        <SourcePicker
          onPick={(picked) => {
            setPickedSource(picked)
            // useEffect on pickedSource will fire startScan().
          }}
          onCancel={() => setPhase({ kind: 'cancelled' })}
        />
      )

    case 'running':
      return <ScanProgress state={phase.progress} />

    case 'trust':
      return (
        <TrustReport
          findings={phase.result.findings}
          durationMs={phase.result.durationMs}
          tokensIn={phase.result.tokens.input}
          tokensOut={phase.result.tokens.output}
          onConfirm={() => {
            const trustResult = phase.result
            const trustUpload = upload!
            // Initial uploading state — UploadProgress shows a starting
            // line until the first orchestrator event arrives.
            setPhase({
              kind: 'uploading',
              result: trustResult,
              upload: trustUpload,
              uploadPhase: { kind: 'starting' },
            })

            const auth = resolveAuth()
            if (auth.source === 'none' || auth.expired || !auth.workspaceId || !auth.token) {
              setPhase({
                kind: 'failed',
                error: 'Not signed in. Run `holostaff login` and try again.',
              })
              return
            }

            postScanStatus({ phase: 'uploading' })

            const events: UploadEvent[] = []
            const appBaseUrl = process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai'

            void uploadFlow({
              cwd,
              baseUrl: auth.baseUrl,
              bearer: auth.token,
              workspaceId: auth.workspaceId,
              appBaseUrl,
              artifact: trustUpload,
              repoOrigin: detectRepoOrigin(cwd),
              mergeMode,
              forceSourceId: pickedSource,
              onEvent: (ev) => {
                events.push(ev)
                setPhase({
                  kind: 'uploading',
                  result: trustResult,
                  upload: trustUpload,
                  uploadPhase: { kind: 'in_flight', events: [...events] },
                })
              },
            }).then((result: UploadResult) => {
              setPhase({
                kind: 'uploading',
                result: trustResult,
                upload: trustUpload,
                uploadPhase: { kind: 'done', result },
              })
            })
          }}
          onSaveLocal={() => {
            void saveLocally(cwd, upload!).then((path) => {
              setPhase({ kind: 'saved', path })
            }).catch((err) => {
              setPhase({ kind: 'failed', error: `couldn't save locally: ${err.message}` })
            })
          }}
          onCancel={() => setPhase({ kind: 'cancelled' })}
        />
      )

    case 'uploading':
      return (
        <Box flexDirection="column">
          <TrustReport
            findings={phase.result.findings}
            durationMs={phase.result.durationMs}
            tokensIn={phase.result.tokens.input}
            tokensOut={phase.result.tokens.output}
            onConfirm={() => { /* disabled */ }}
            onSaveLocal={() => { /* disabled */ }}
            onCancel={() => { /* disabled */ }}
            inputDisabled
          />
          <UploadProgress phase={phase.uploadPhase} />
        </Box>
      )

    case 'saved':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="green">✓ Saved to {phase.path}</Text>
          <Text color="gray">Inspect it, then re-run and upload when ready.</Text>
        </Box>
      )

    case 'cancelled':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Cancelled. Nothing was uploaded.</Text>
        </Box>
      )

    case 'failed':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">✗ Scan failed</Text>
          <Text color="gray">{phase.error}</Text>
        </Box>
      )
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color="gray">{children}</Text>
    </Box>
  )
}

async function saveLocally(cwd: string, upload: CliArtifactUpload): Promise<string> {
  const dir = join(cwd, '.holostaff')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `scan-${stamp()}.json`)
  await writeFile(file, JSON.stringify(upload, null, 2), 'utf8')
  return file
}

function stamp(): string {
  // ISO-ish but filesystem-safe.
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
}
