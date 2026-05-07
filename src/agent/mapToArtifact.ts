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
  workflows: ScanFindings['workflows']
  coverageGaps: string[]
  notes?: string
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
    workflows: findings.workflows,
    coverageGaps: findings.coverageGaps,
    notes: findings.notes,
  }
}
