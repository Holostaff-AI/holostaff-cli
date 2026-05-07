/**
 * proposeInstrumentationPlan — the agent's exit tool for /instrument.
 *
 * Same shape as scan's submitFindings: a per-run sink captures the
 * validated plan, the orchestrator hands it to the diff/apply UI.
 * First valid call wins; later calls are rejected so the agent can't
 * accidentally overwrite a plan it already submitted.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { InstrumentationPlanSchema, type InstrumentationPlan } from './instrumentSchema.js'

export interface InstrumentationSink {
  capture(plan: InstrumentationPlan): void
  isCaptured(): boolean
}

export function makeProposeInstrumentationTool(sink: InstrumentationSink) {
  return tool(
    'proposeInstrumentationPlan',
    [
      'Submit the proposed instrumentation patch. Call this EXACTLY ONCE',
      'once you\'ve drafted a complete plan. After submitting, the run is',
      'over — do not invoke any further tools. Arguments are validated;',
      'if validation fails, fix the payload and call again.',
    ].join(' '),
    InstrumentationPlanSchema.shape,
    async (args) => {
      const parsed = InstrumentationPlanSchema.safeParse(args)
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `proposeInstrumentationPlan rejected: ${parsed.error.issues
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
              text: 'A plan was already received. The /instrument run is complete; do not call this tool again.',
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
