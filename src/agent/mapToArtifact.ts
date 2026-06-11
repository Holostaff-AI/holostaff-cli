/**
 * findings → upload payload mapper.
 *
 * The agent's ScanFindings shape is intentionally close to the
 * server's KnowledgeArtifact content fields, so the mapping is mostly
 * identity. This module exists to:
 *   - keep CLI ↔ server boundary types explicit (scan output vs. wire format)
 *   - centralise the runId construction so callers don't reinvent it
 *   - assert the language enum is one the server accepts (the agent
 *     is theoretically free-form here, but we narrow at the boundary)
 *
 * Server-side (synthesizeCliArtifact) wraps this with id/version/
 * ingestedAt/customerEdits/updates — those are persistence metadata,
 * not content.
 */

import type { ScanFindings } from './findingsSchema.js'

export type ArtifactLanguage = 'typescript' | 'javascript' | 'mixed' | 'unknown'

/** Wire shape for an instrumentation call site (matches the server's
 *  InstrumentationCallSiteSchema). */
interface WireCallSite {
  kind: 'markStageEntry' | 'identify' | 'clearIdentity' | 'emitSignal'
  anchor:
    | { kind: 'step'; stepIndex: number }
    | { kind: 'sign_in_complete'; component?: string }
    | { kind: 'sign_out'; component?: string }
  file?: string
  signalName?: string
}

/** Workflow as uploaded — findings shape plus the instrumentation
 *  declarations derived from `signals[]`. */
type WireWorkflow = Omit<ScanFindings['workflows'][number], 'signals'> & {
  instrumentation?: { expected: WireCallSite[]; detected: WireCallSite[] }
}

export interface CliArtifactUpload {
  runId: string
  ingestedVia: 'cli_scan'
  ingestedAt: string

  productName: string
  oneLineDescription: string
  primaryFramework: string
  language: ArtifactLanguage

  routes: ScanFindings['routes']
  components: ScanFindings['components']
  copy: ScanFindings['copy']
  brandVoice?: ScanFindings['brandVoice']
  /**
   * Workflows carry `risks` + `interventions` (v0.2) and now
   * `instrumentation.expected` emitSignal declarations derived from
   * the agent's taxonomy walk (v0.3). The server merges these with
   * its own derived markStageEntry declarations.
   */
  workflows: WireWorkflow[]
  coverageGaps: string[]
  notes?: string
  /**
   * Identity surfaces the agent found (OAuth callbacks, auth-state
   * listeners). Server merges with its route-name heuristic into
   * `identityInstrumentation.expected`.
   */
  declaredIdentityInstrumentation?: WireCallSite[]
}

export interface MapToArtifactInput {
  findings: ScanFindings
  /** CLI session id — surfaces in the run record for cross-referencing. */
  cliSessionId?: string
}

export function mapFindingsToUpload(input: MapToArtifactInput): CliArtifactUpload {
  const { findings, cliSessionId } = input

  // runId tag: cli_<base36 timestamp>[_<sessionShort>]. The Claude
  // Agent SDK session id is a UUID; including the first 8 chars keeps
  // the runId greppable against the agent's session log without bloat.
  const stamp = Date.now().toString(36)
  const sessionPart = cliSessionId ? `_${cliSessionId.replace(/-/g, '').slice(0, 8)}` : ''
  const runId = `cli_${stamp}${sessionPart}`

  // Convert each workflow's taxonomy-walk `signals[]` into emitSignal
  // declarations the server folds into instrumentation.expected.
  const workflows: WireWorkflow[] = findings.workflows.map(wf => {
    const { signals, ...rest } = wf
    const expected: WireCallSite[] = (signals ?? []).map(s => ({
      kind: 'emitSignal',
      signalName: s.name,
      anchor: { kind: 'step', stepIndex: s.stepIndex },
      ...(s.file ? { file: s.file } : {}),
    }))
    return expected.length
      ? { ...rest, instrumentation: { expected, detected: [] } }
      : rest
  })

  // Identity surfaces → declared identify/clearIdentity call sites.
  const declaredIdentity: WireCallSite[] = (findings.identitySurfaces ?? []).map(s => ({
    kind: s.kind === 'sign_in_complete' ? 'identify' : 'clearIdentity',
    anchor: s.kind === 'sign_in_complete'
      ? { kind: 'sign_in_complete', ...(s.component ? { component: s.component } : {}) }
      : { kind: 'sign_out', ...(s.component ? { component: s.component } : {}) },
    file: s.file,
  }))

  return {
    runId,
    ingestedVia: 'cli_scan',
    ingestedAt: new Date().toISOString(),

    productName: findings.productName.trim(),
    oneLineDescription: findings.oneLineDescription.trim(),
    primaryFramework: findings.primaryFramework.trim(),
    language: findings.language,

    routes: findings.routes,
    components: findings.components,
    copy: findings.copy,
    brandVoice: findings.brandVoice,
    workflows,
    coverageGaps: findings.coverageGaps,
    notes: findings.notes,
    ...(declaredIdentity.length ? { declaredIdentityInstrumentation: declaredIdentity } : {}),
  }
}
