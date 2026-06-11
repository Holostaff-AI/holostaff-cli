/**
 * Bowtie stage decomposition — structured framework data.
 *
 * Mirrors `server/src/bowtie/knowledge/stageDecomposition.ts`. The two
 * copies must stay in sync — the server owns the authoritative content
 * and validates against this taxonomy; the CLI uses it to prompt the
 * scan agent on what risks to look for and what interventions to design.
 *
 * 36 sub-steps total (Stages 1–6 have 5 each, Stage 7 has 6).
 *
 * Reference: documents/copilot-interventions-design.md §8.4.
 */

export type BowtieStage =
  | 'awareness'
  | 'education'
  | 'selection'
  | 'mutual_commit'
  | 'onboarding'
  | 'adoption'
  | 'expansion'

export type SubStepId = string

export interface SubStep {
  id: SubStepId
  stage: BowtieStage
  /** Short human name, e.g. 'Arrival', 'Orientation'. */
  name: string
  /** What is true about the visitor's understanding / posture. */
  visitorState: string
  /** Visually observable behavior a watching agent can see in real time. */
  observableSignal: string
  /** Most common reason visitors don't move to the next sub-step. */
  stallPoint: string
  /** What needs to happen for the transition, agnostic of who/what does it. */
  jobToBeDone: string
}

export const STAGE_DECOMPOSITION: SubStep[] = [
  // Stage 1 — Awareness
  {
    id: '1a',
    stage: 'awareness',
    name: 'Arrival',
    visitorState: 'Just landed; hasn\'t engaged.',
    observableSignal: 'Page loaded; referrer present; no scroll or click yet.',
    stallPoint: 'Misaligned traffic source → instant bounce.',
    jobToBeDone: 'Make the page legible as a destination in the first 1–2 seconds.',
  },
  {
    id: '1b',
    stage: 'awareness',
    name: 'Orientation',
    visitorState: 'Scanning to figure out what this is.',
    observableSignal: 'Shallow scroll; fast hover-skim; < 10s dwell.',
    stallPoint: 'Hero copy doesn\'t match visitor\'s expectation.',
    jobToBeDone: 'Communicate what this is, for whom, in under 10 seconds.',
  },
  {
    id: '1c',
    stage: 'awareness',
    name: 'Problem resonance',
    visitorState: 'Reading specifics that match their situation.',
    observableSignal: 'Medium scroll depth; 15–30s dwell; pace slows.',
    stallPoint: 'Visitor doesn\'t see their situation reflected.',
    jobToBeDone: 'Surface a concrete instance of the visitor\'s situation as evidence "this is for you".',
  },
  {
    id: '1d',
    stage: 'awareness',
    name: 'Self-identification',
    visitorState: '"Yes, that\'s me" — emotional flicker.',
    observableSignal: '30+s dwell; scroll past ~40%; section-return pattern.',
    stallPoint: 'Recognizes the problem but feels no urgency to act.',
    jobToBeDone: 'Convert recognition into "I want to do something about this now".',
  },
  {
    id: '1e',
    stage: 'awareness',
    name: 'Curiosity',
    visitorState: 'Wants to see how this works.',
    observableSignal: 'Nav click to docs / "how it works" / pricing; multi-tab behavior.',
    stallPoint: 'Curiosity dissipates before reaching Education.',
    jobToBeDone: 'Route the curious visitor to the right next surface without making them choose.',
  },

  // Stage 2 — Education
  {
    id: '2a',
    stage: 'education',
    name: 'Concept grasp',
    visitorState: '"What category is this?"',
    observableSignal: 'Dwell on intro / concept pages; slow scroll on first-screen explainer.',
    stallPoint: 'Wrong mental model from prior product or category.',
    jobToBeDone: 'Anchor the concept in something the visitor already knows.',
  },
  {
    id: '2b',
    stage: 'education',
    name: 'Mechanics grasp',
    visitorState: '"How does it actually work?"',
    observableSignal: 'Dwell on architecture / flow diagrams; expanded sections; rewatch of demo video.',
    stallPoint: 'Explanation too abstract; visitor wants "show me, don\'t tell me".',
    jobToBeDone: 'Make the mechanism concrete via example, interaction, or worked walkthrough.',
  },
  {
    id: '2c',
    stage: 'education',
    name: 'Use-case fit',
    visitorState: '"Does it work for my situation?"',
    observableSignal: 'Navigation between use-case pages; in-page search interactions.',
    stallPoint: 'Their use case isn\'t visibly documented.',
    jobToBeDone: 'Surface (or generate) a use case that mirrors the visitor\'s situation.',
  },
  {
    id: '2d',
    stage: 'education',
    name: 'Capability mapping',
    visitorState: '"Can it do A, B, and not break on C?"',
    observableSignal: 'Tooltip reopens; feature-page dwell; comparison-table interaction.',
    stallPoint: 'Imagined or real capability gap.',
    jobToBeDone: 'Honestly answer "can it do X?" — including saying "no" when the answer is no.',
  },
  {
    id: '2e',
    stage: 'education',
    name: 'Trust formation',
    visitorState: '"Are these people real?"',
    observableSignal: 'Navigation to about / customers / team / blog; slow read on testimonial blocks.',
    stallPoint: 'Insufficient or wrong-segment social proof.',
    jobToBeDone: 'Surface a trust-building artifact matching the visitor\'s segment.',
  },

  // Stage 3 — Selection
  {
    id: '3a',
    stage: 'selection',
    name: 'Situation framing',
    visitorState: '"What is my exact situation?"',
    observableSignal: 'Pricing-page dwell; interaction with plan / seat / volume sliders; comparison-style hover.',
    stallPoint: 'Visitor doesn\'t know their own variables (team size, volume, current cost).',
    jobToBeDone: 'Help the visitor articulate their own situation in concrete terms.',
  },
  {
    id: '3b',
    stage: 'selection',
    name: 'Pain quantification',
    visitorState: '"How much is this costing me today?"',
    observableSignal: 'ROI / calculator interactions; spreadsheet-style downloads; repeat visits to pricing.',
    stallPoint: 'Can\'t price the cost of inaction.',
    jobToBeDone: 'Surface a comparable estimate the visitor can defend internally.',
  },
  {
    id: '3c',
    stage: 'selection',
    name: 'Impact projection',
    visitorState: '"What will it look like after?"',
    observableSignal: 'Case-study clicks; customer-story dwell; demo-booking page visit.',
    stallPoint: 'Can\'t visualize the after-state credibly.',
    jobToBeDone: 'Show a believable before/after for a situation similar to the visitor\'s.',
  },
  {
    id: '3d',
    stage: 'selection',
    name: 'Risk assessment',
    visitorState: '"What happens if this doesn\'t work?"',
    observableSignal: 'Trial-length / cancellation / ToS / refund page dwell.',
    stallPoint: 'Fear of being stuck outweighs perceived upside.',
    jobToBeDone: 'Surface the rollback path explicitly and make it easy to find.',
  },
  {
    id: '3e',
    stage: 'selection',
    name: 'Decision trigger',
    visitorState: '"OK, I\'ll try."',
    observableSignal: 'Signup CTA hover; plan-modal interaction; return-to-pricing loop; idle on selection page.',
    stallPoint: 'Decision fatigue → defer → never return.',
    jobToBeDone: 'Collapse the choice to a single recommended next step.',
  },

  // Stage 4 — Mutual Commit
  {
    id: '4a',
    stage: 'mutual_commit',
    name: 'Intent declared',
    visitorState: 'Clicked signup or start-trial.',
    observableSignal: 'Signup CTA click; plan selection.',
    stallPoint: '—',
    jobToBeDone: 'Minimize the gap between intent and the next action.',
  },
  {
    id: '4b',
    stage: 'mutual_commit',
    name: 'Identity provided',
    visitorState: 'Email / OAuth / phone.',
    observableSignal: 'Form-field interactions; field abandonment; OAuth modal dwell.',
    stallPoint: 'Form too long; aggressive OAuth scope; "create password" friction.',
    jobToBeDone: 'Reduce the perceived cost of identifying.',
  },
  {
    id: '4c',
    stage: 'mutual_commit',
    name: 'Account created',
    visitorState: 'Credentials valid.',
    observableSignal: 'Post-signup screens; email-verification page dwell.',
    stallPoint: 'Verification wall — large drop here.',
    jobToBeDone: 'Minimize blockers between credential creation and first app entry.',
  },
  {
    id: '4d',
    stage: 'mutual_commit',
    name: 'Workspace setup',
    visitorState: 'First config.',
    observableSignal: 'Setup-wizard pages; slow dwell; repeated back-button.',
    stallPoint: 'Forced upfront configuration before any action is possible.',
    jobToBeDone: 'Defer any decision that can be made later.',
  },
  {
    id: '4e',
    stage: 'mutual_commit',
    name: 'First entry',
    visitorState: 'Logged in to the app.',
    observableSignal: 'First `app_home` / dashboard page load.',
    stallPoint: 'Empty state with no obvious next step.',
    jobToBeDone: 'Orient the user inside the app within 5 seconds.',
  },

  // Stage 5 — Onboarding (Activation)
  {
    id: '5a',
    stage: 'onboarding',
    name: 'App orientation',
    visitorState: '"Where am I?"',
    observableSignal: 'Dwell on empty dashboard; no clicks; slow exploratory scroll.',
    stallPoint: 'Empty-state paralysis.',
    jobToBeDone: 'Spotlight the single most valuable next action.',
  },
  {
    id: '5b',
    stage: 'onboarding',
    name: 'First setup',
    visitorState: 'Connecting accounts, API keys, integrations.',
    observableSignal: 'Config / integrations page dwell; repeated tab-switching to credentials / docs.',
    stallPoint: 'Stuck on external setup (where to find keys, how to wire).',
    jobToBeDone: 'Bridge the gap between "what to paste" and "where to find it".',
  },
  {
    id: '5c',
    stage: 'onboarding',
    name: 'First attempt',
    visitorState: 'Tries the core action.',
    observableSignal: 'Form interactions in core workflow; error banners visible; idle mid-step.',
    stallPoint: 'Confusion about input format; unclear error states.',
    jobToBeDone: 'Unblock the specific friction or offer an honest handoff.',
  },
  {
    id: '5d',
    stage: 'onboarding',
    name: 'First success',
    visitorState: 'Completes the core action.',
    observableSignal: 'Completion screens; success banners; "done" animations.',
    stallPoint: 'Action succeeded but visitor didn\'t notice.',
    jobToBeDone: 'Explicitly mark the success state as something to recognize.',
  },
  {
    id: '5e',
    stage: 'onboarding',
    name: 'First impact',
    visitorState: 'Sees the result — Δt6 fires here.',
    observableSignal: 'Visitor sees output rendered (populated list, drawn chart, sent message confirmation).',
    stallPoint: 'Output is produced but value isn\'t perceived.',
    jobToBeDone: 'Name the impact so the visitor recognizes it as the outcome they came for.',
  },

  // Stage 6 — Adoption
  {
    id: '6a',
    stage: 'adoption',
    name: 'Return',
    visitorState: 'Logged back in for session 2+.',
    observableSignal: 'Returning visitor; gap between sessions; dwell on resume / dashboard view.',
    stallPoint: 'Gap between sessions kills momentum — doesn\'t remember what they did or why.',
    jobToBeDone: 'Restore continuity from the last session.',
  },
  {
    id: '6b',
    stage: 'adoption',
    name: 'Routine formation',
    visitorState: 'Repeating the same workflow.',
    observableSignal: 'Repeated identical action sequences; time-of-day regularity.',
    stallPoint: 'Manual repetition where automation is possible.',
    jobToBeDone: 'Notice the routine and offer a faster path.',
  },
  {
    id: '6c',
    stage: 'adoption',
    name: 'Depth',
    visitorState: 'Explores beyond the first feature.',
    observableSignal: 'Navigation to previously-unvisited app sections; tooltip opens on new features.',
    stallPoint: 'Stuck on the first feature; never discovers the rest.',
    jobToBeDone: 'Surface an adjacent feature anchored to the visitor\'s current activity.',
  },
  {
    id: '6d',
    stage: 'adoption',
    name: 'Reliance',
    visitorState: 'Depends on the product for ongoing work.',
    observableSignal: 'High session frequency; multiple integrations active; long working sessions.',
    stallPoint: 'Approaching limits or hitting performance walls.',
    jobToBeDone: 'Surface bottlenecks before the visitor hits them.',
  },
  {
    id: '6e',
    stage: 'adoption',
    name: 'Habit',
    visitorState: 'Uses without thinking.',
    observableSignal: 'Stable usage patterns; low support contact.',
    stallPoint: 'Plateau — using the product but not getting more impact from it.',
    jobToBeDone: 'Surface unexplored adjacent value at a natural moment.',
  },

  // Stage 7 — Expansion
  {
    id: '7a',
    stage: 'expansion',
    name: 'Capacity hit',
    visitorState: 'Hits a feature gap or limit.',
    observableSignal: 'Limit-reached banners; feature-not-found searches; upgrade-modal hover-and-dismiss.',
    stallPoint: 'Friction → defer → forget → churn risk.',
    jobToBeDone: 'Connect the current friction to its specific resolution.',
  },
  {
    id: '7b',
    stage: 'expansion',
    name: 'Internal advocacy',
    visitorState: 'Mentions to a colleague.',
    observableSignal: 'Share-button clicks; copy-link interactions; email-compose patterns.',
    stallPoint: 'Mentioned, but no clear pathway for the colleague to see what they saw.',
    jobToBeDone: 'Make the shared artifact useful on its own — not gated behind a signup.',
  },
  {
    id: '7c',
    stage: 'expansion',
    name: 'Team pilot',
    visitorState: 'Colleague signs up.',
    observableSignal: 'Invite-modal completions; multiple signups from same domain; "join existing workspace" interactions.',
    stallPoint: 'Colleague signs up in a parallel silo instead of joining the existing team.',
    jobToBeDone: 'Ensure the new user lands inside the existing account, not next to it.',
  },
  {
    id: '7d',
    stage: 'expansion',
    name: 'Team adoption',
    visitorState: 'Multiple users on the same account.',
    observableSignal: 'Multiple active users in the workspace; admin dashboards; usage-analytics page dwell.',
    stallPoint: 'Only the champion uses it; team installed but inactive.',
    jobToBeDone: 'Surface usage gaps to the admin so they can drive adoption inside the org.',
  },
  {
    id: '7e',
    stage: 'expansion',
    name: 'Account expansion',
    visitorState: 'Upgrade decision.',
    observableSignal: 'Plan-comparison dwell; billing-page interactions; plan-change modal.',
    stallPoint: 'Decision-maker isn\'t the user — champion has to sell internally.',
    jobToBeDone: 'Enable the champion to defend the upgrade internally.',
  },
  {
    id: '7f',
    stage: 'expansion',
    name: 'Champion change',
    visitorState: 'Champion leaves; new person inherits.',
    observableSignal: 'Previously-active user goes silent; a new user logs in as admin with no orientation patterns.',
    stallPoint: 'Champion change is invisible; new admin is lost.',
    jobToBeDone: 'Detect the handoff early and onboard the new admin from scratch.',
  },
]

/**
 * Pre-bucketed by stage for the CLI's per-workflow second pass:
 * given a workflow's bowtieStage, walk just the matching sub-steps.
 */
export const SUBSTEPS_BY_STAGE: Record<BowtieStage, SubStep[]> = STAGE_DECOMPOSITION.reduce(
  (acc, s) => {
    if (!acc[s.stage]) acc[s.stage] = []
    acc[s.stage].push(s)
    return acc
  },
  {} as Record<BowtieStage, SubStep[]>,
)

export function findSubStep(id: SubStepId): SubStep | undefined {
  return STAGE_DECOMPOSITION.find((s) => s.id === id)
}

/**
 * Render the full taxonomy as a compact markdown block for inclusion
 * in the scan-agent system prompt. One line per sub-step: id,
 * human name, the observable signal, and the stall point. The agent
 * uses this to map sub-steps onto specific journey steps and to know
 * what signal/label/intervention is appropriate.
 */
const STAGE_LABELS: Record<BowtieStage, string> = {
  awareness: 'Awareness',
  education: 'Education',
  selection: 'Selection',
  mutual_commit: 'Mutual Commit',
  onboarding: 'Onboarding',
  adoption: 'Adoption',
  expansion: 'Expansion',
}

export function renderFrameworkForPrompt(): string {
  const stages: BowtieStage[] = [
    'awareness', 'education', 'selection', 'mutual_commit',
    'onboarding', 'adoption', 'expansion',
  ]
  const lines: string[] = []
  for (const stage of stages) {
    lines.push(`\n${STAGE_LABELS[stage]}:`)
    for (const s of SUBSTEPS_BY_STAGE[stage] ?? []) {
      lines.push(
        `- ${s.id} · ${s.name} — signal: ${s.observableSignal} | stall: ${s.stallPoint} | job: ${s.jobToBeDone}`,
      )
    }
  }
  return lines.join('\n').trim()
}
