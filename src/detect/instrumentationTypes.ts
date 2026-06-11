/**
 * Types — duplicate of the subset of server schema this detector
 * needs. Kept independent so the cli-extensions module doesn't drag
 * server/zod into the CLI runtime.
 *
 * Port note: when this module lands in github.com/Holostaff-AI/holostaff-cli,
 * import the same types from the CLI's existing artifact upload schema
 * if one exists; otherwise keep this file.
 */

export type BowtieStage =
  | 'awareness'
  | 'education'
  | 'selection'
  | 'mutual_commit'
  | 'onboarding'
  | 'adoption'
  | 'expansion'

export interface EntryPage {
  route: string
  text?: string
}

export interface WorkflowLite {
  name: string
  bowtieStage: BowtieStage
  entryPages: EntryPage[]
}

export interface RouteLite {
  path: string
  file?: string
}

export type InstrumentationKind =
  | 'markStageEntry'
  | 'identify'
  | 'clearIdentity'
  | 'emitSignal'

export type InstrumentationAnchor =
  | { kind: 'entry_page'; route: string }
  | { kind: 'step'; stepIndex: number }
  | { kind: 'sign_in_complete'; component?: string }
  | { kind: 'sign_out'; component?: string }
  | { kind: 'custom_event'; description?: string }

export interface InstrumentationCallSite {
  kind: InstrumentationKind
  anchor: InstrumentationAnchor
  file?: string
  line?: number
  stage?: BowtieStage
  signalName?: string
}

export interface DetectionResult {
  /** Calls discovered, bucketed by workflow name. */
  workflows: Record<string, InstrumentationCallSite[]>
  /** Cross-workflow identify / clearIdentity calls. */
  identity: InstrumentationCallSite[]
  /** Files walked and their disposition (for logging + future visibility). */
  filesScanned: Array<{ file: string; callsFound: number }>
}
