/**
 * Plan-submission exit tool factory.
 *
 * Both /instrument and /embed produce the same plan shape (install +
 * edit + create ops with unique-anchor edits) — the difference is the
 * prompt + tool name the agent sees. This factory takes the tool name
 * + description and returns a configured tool that captures the plan
 * to a per-run sink.
 *
 * First valid call wins; later calls are rejected so the agent can't
 * accidentally overwrite the plan it already submitted.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { InstrumentationPlanSchema, type InstrumentationPlan } from './instrumentSchema.js'

export interface InstrumentationSink {
  capture(plan: InstrumentationPlan): void
  isCaptured(): boolean
}

export interface ProposePlanToolConfig {
  /** Tool name as the agent sees it (un-prefixed; the SDK adds mcp__server__). */
  name: string
  /** One-line description shown to the model in its tool catalog. */
  description: string
  /** Where the validated plan goes. */
  sink: InstrumentationSink
  /** Used in error messages back to the agent ("the /instrument run is complete"). */
  runLabel: string
}

export function makeProposePlanTool(config: ProposePlanToolConfig) {
  const { name, description, sink, runLabel } = config
  return tool(
    name,
    description,
    InstrumentationPlanSchema.shape,
    async (args) => {
      const parsed = InstrumentationPlanSchema.safeParse(args)
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${name} rejected: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}. Fix the payload and call again.`,
            },
          ],
          isError: true,
        }
      }
      if (sink.isCaptured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `A plan was already received. The ${runLabel} run is complete; do not call this tool again.`,
            },
          ],
          isError: true,
        }
      }
      sink.capture(parsed.data)
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Plan accepted. Run complete — no further tool calls needed.',
          },
        ],
      }
    },
  )
}

/** /instrument's specific configuration — kept here so callers don't have to know the description text. */
export function makeProposeInstrumentationTool(sink: InstrumentationSink) {
  return makeProposePlanTool({
    name: 'proposeInstrumentationPlan',
    description: [
      'Submit the proposed instrumentation patch. Call this EXACTLY ONCE',
      'once you\'ve drafted a complete plan. After submitting, the run is',
      'over — do not invoke any further tools. Arguments are validated;',
      'if validation fails, fix the payload and call again.',
    ].join(' '),
    sink,
    runLabel: '/instrument',
  })
}
