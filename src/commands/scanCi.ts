/**
 * runScanCi — headless scan + upload for CI / scripted use.
 *
 * Differences from the interactive flow:
 *   - No Ink UI. Status lines go to stderr (suppressed in --quiet).
 *   - Auth resolved from env (HOLOSTAFF_API_KEY + HOLOSTAFF_WORKSPACE_ID),
 *     not from ~/.holostaff/credentials.json. The interactive flow's
 *     resolveAuth() handles this priority correctly already; we just
 *     refuse to proceed if the env path didn't resolve to source='env'.
 *   - Auto-confirms the upload — no trust report prompt. The script
 *     assumes the customer has already signed off on running CLI in CI.
 *   - Emits a structured JSON result on stdout (or --out path) and
 *     uses typed exit codes so shell pipelines can branch on them.
 *
 * Exit codes:
 *   0  uploaded ok
 *   1  scan / upload error
 *   2  bad args / preflight failure (env missing)
 *   3  auth not configured for CI
 */

import { writeFileSync } from 'node:fs'
import type { ScanArgs } from './argv.js'
import { resolveAuth } from '../auth/credentials.js'
import { runScan, type ScanEvent } from '../agent/runScan.js'
import { mapFindingsToUpload } from '../agent/mapToArtifact.js'
import { uploadFlow, type UploadEvent } from '../agent/uploadArtifact.js'
import { emit as emitTelemetry, bucketSize } from '../telemetry.js'

export interface CiScanResult {
  ok: boolean
  /** Set on failure; describes which phase ('scan' | 'upload' | 'auth' | 'env') failed. */
  phase?: 'scan' | 'upload' | 'auth' | 'env'
  error?: string

  /** Populated on success. */
  scan?: {
    durationMs: number
    sessionId: string | undefined
    tokens: { input: number; output: number }
  }
  upload?: {
    sourceId: string
    sourceName: string
    version: number
    artifactId: string
    viewUrl: string
    isNewSource: boolean
  }
  findings?: {
    productName: string
    oneLineDescription: string
    primaryFramework: string
    language: string
    counts: {
      routes: number
      components: number
      copy: number
      workflows: number
      coverageGaps: number
    }
    coverageGaps: string[]
  }
}

export async function runScanCi(opts: ScanArgs, cwd: string): Promise<number> {
  const log = opts.quiet ? () => { /* suppressed */ } : (line: string) => process.stderr.write(line + '\n')
  const t0 = Date.now()

  // 1. Auth — env key (CI) or file-backed credentials (local scripted
  // runs: same machine, same user who ran `holostaff login`). File
  // creds were previously rejected here, which made every local
  // headless invocation fail for no security gain.
  const auth = resolveAuth()
  if (auth.source === 'none' || !auth.token || !auth.workspaceId) {
    emitTelemetry({
      command: 'scan_ci',
      outcome: 'error',
      errorKind: 'auth_missing',
      durationMs: Date.now() - t0,
    })
    return emitFailure(opts, {
      ok: false,
      phase: 'auth',
      error: 'Not signed in. Set HOLOSTAFF_API_KEY (and HOLOSTAFF_WORKSPACE_ID) for CI mode, or run `holostaff login` for interactive mode.',
    }, log, 3)
  }
  if (auth.source === 'file' && auth.expired) {
    emitTelemetry({
      command: 'scan_ci',
      outcome: 'error',
      errorKind: 'auth_expired',
      durationMs: Date.now() - t0,
    })
    return emitFailure(opts, {
      ok: false,
      phase: 'auth',
      error: 'Token expired. Run `holostaff login` to refresh.',
    }, log, 3)
  }

  log(`· authed as workspace ${auth.workspaceId} via ${auth.source === 'env' ? 'env' : 'local credentials'}`)
  log(`· running scan on ${cwd}`)

  // 2. Run scan.
  const { buildAgentEnv } = await import('../agent/runScan.js')
  const env = await buildAgentEnv()
  if (!env) {
    emitTelemetry({
      command: 'scan_ci',
      outcome: 'error',
      errorKind: 'env_missing',
      durationMs: Date.now() - t0,
    })
    return emitFailure(opts, {
      ok: false,
      phase: 'env',
      error:
        'Couldn\'t resolve model credentials. CI mode mints them from /api/cli/model-session via HOLOSTAFF_API_KEY; or set AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY for BYO-key.',
    }, log, 2)
  }

  let lastTool = ''
  const scanResult = await runScan({
    cwd,
    env,
    onEvent: (ev: ScanEvent) => {
      if (ev.type === 'tool_use') {
        if (ev.tool !== lastTool) {
          log(`· tool ${ev.tool}`)
          lastTool = ev.tool
        }
      }
    },
  })

  if (!scanResult.ok) {
    emitTelemetry({
      command: 'scan_ci',
      outcome: 'error',
      errorKind: `scan_${scanResult.reason}`,
      durationMs: Date.now() - t0,
    })
    return emitFailure(opts, {
      ok: false,
      phase: 'scan',
      error: `scan failed (${scanResult.reason}): ${scanResult.error}`,
      scan: {
        durationMs: scanResult.durationMs,
        sessionId: scanResult.sessionId,
        tokens: { input: 0, output: 0 },
      },
    }, log, 1)
  }
  log(`· scan ok in ${scanResult.durationMs}ms`)

  // 3. Upload.
  const upload = mapFindingsToUpload({
    findings: scanResult.findings,
    cliSessionId: scanResult.sessionId,
  })
  const appBaseUrl = process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai'

  log(`· uploading artifact${opts.addRepo ? ` (merge into ${opts.addRepo})` : ''}`)
  const uploadResult = await uploadFlow({
    cwd,
    baseUrl: auth.baseUrl,
    bearer: auth.token,
    workspaceId: auth.workspaceId,
    appBaseUrl,
    artifact: upload,
    mergeMode: opts.addRepo ? 'append' : 'replace',
    forceSourceId: opts.addRepo
      ? { sourceId: opts.addRepo, sourceName: opts.addRepo }
      : undefined,
    onEvent: (ev: UploadEvent) => {
      if (ev.type === 'creating_source') log(`  · creating source ${ev.name}`)
      if (ev.type === 'source_created') log(`  ✓ source created ${ev.sourceId}`)
      if (ev.type === 'reusing_source') log(`  · reusing source ${ev.sourceId}`)
      if (ev.type === 'uploaded') log(`  ✓ uploaded v${ev.version}`)
      if (ev.type === 'failed') log(`  ✗ ${ev.error}`)
    },
  })
  if (!uploadResult.ok) {
    emitTelemetry({
      command: 'scan_ci',
      outcome: 'error',
      errorKind: `upload_${uploadResult.step}`,
      durationMs: Date.now() - t0,
      frameworkDetected: scanResult.findings.primaryFramework,
    })
    return emitFailure(opts, {
      ok: false,
      phase: 'upload',
      error: `upload failed (${uploadResult.step}): ${uploadResult.error}`,
    }, log, 1)
  }
  log(`✓ ${uploadResult.viewUrl}`)

  // 4. Emit result.
  const f = scanResult.findings
  const result: CiScanResult = {
    ok: true,
    scan: {
      durationMs: scanResult.durationMs,
      sessionId: scanResult.sessionId,
      tokens: scanResult.tokens,
    },
    upload: {
      sourceId: uploadResult.sourceId,
      sourceName: uploadResult.sourceName,
      version: uploadResult.version,
      artifactId: uploadResult.artifactId,
      viewUrl: uploadResult.viewUrl,
      isNewSource: uploadResult.isNewSource,
    },
    findings: {
      productName: f.productName,
      oneLineDescription: f.oneLineDescription,
      primaryFramework: f.primaryFramework,
      language: f.language,
      counts: {
        routes: f.routes.length,
        components: f.components.length,
        copy: f.copy.length,
        workflows: f.workflows.length,
        coverageGaps: f.coverageGaps.length,
      },
      coverageGaps: f.coverageGaps,
    },
  }

  // Telemetry: bucketed source-file count would require running detect
  // here too. For the success path we skip bucketing; the framework is
  // signal enough. Bucketing lands when the Scan UI emits its own
  // events (later A8 push).
  emitTelemetry({
    command: 'scan_ci',
    outcome: 'success',
    durationMs: Date.now() - t0,
    frameworkDetected: f.primaryFramework,
    repoSizeBucket: bucketSize(f.routes.length + f.components.length),
  })

  return emitResult(opts, result, log, 0)
}

// ────────────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────────────

function emitResult(
  opts: ScanArgs,
  result: CiScanResult,
  log: (s: string) => void,
  exitCode: number,
): number {
  if (opts.json) {
    const json = JSON.stringify(result, null, 2)
    if (opts.out) {
      writeFileSync(opts.out, json + '\n', { encoding: 'utf8' })
      log(`· wrote ${opts.out}`)
    } else {
      process.stdout.write(json + '\n')
    }
    return exitCode
  }
  // Plain text fallback (--quiet without --json: print just the URL).
  if (result.upload && result.ok) {
    process.stdout.write(`${result.upload.viewUrl}\n`)
  }
  return exitCode
}

function emitFailure(
  opts: ScanArgs,
  result: CiScanResult,
  log: (s: string) => void,
  exitCode: number,
): number {
  // Always log the error to stderr regardless of --quiet — silently
  // failing in CI is much worse than one stderr line.
  process.stderr.write(`✗ ${result.error}\n`)
  if (opts.json) {
    const json = JSON.stringify(result, null, 2)
    if (opts.out) {
      writeFileSync(opts.out, json + '\n', { encoding: 'utf8' })
    } else {
      process.stdout.write(json + '\n')
    }
  }
  void log
  return exitCode
}
