/**
 * submitSkeleton — the two-phase scan's early exit ramp (Pass 1).
 *
 * The agent calls this the moment the structural map is coherent:
 * product identity, routes, components, and workflow skeletons (name,
 * entryPages, steps, bowtieStage) — NO risks, interventions, signals,
 * brand voice, or design tokens. The CLI uploads it immediately as a
 * `depth: 'skeleton'` artifact so the user's journey map is live in
 * under ~90 seconds, then the same conversation continues into the
 * deep pass and finishes with submitFindings as before.
 *
 * Callable once; does NOT lock submitFindings.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ScanFindingsSchema, type ScanFindings } from '../findingsSchema.js'

// Derive the skeleton schema from the full one: keep the cheap
// structural fields, strip workflows down to their skeleton, drop the
// deep fields entirely.
const FullShape = ScanFindingsSchema.shape
const FullWorkflow = ScanFindingsSchema.shape.workflows.removeDefault().element

export const SkeletonWorkflowSchema = FullWorkflow.pick({
  name: true,
  entryPages: true,
  steps: true,
  bowtieStage: true,
})

export const ScanSkeletonSchema = z.object({
  productName: FullShape.productName,
  oneLineDescription: FullShape.oneLineDescription,
  primaryFramework: FullShape.primaryFramework,
  language: FullShape.language,
  routes: FullShape.routes,
  components: FullShape.components,
  workflows: z.array(SkeletonWorkflowSchema).min(1),
})

export type ScanSkeleton = z.infer<typeof ScanSkeletonSchema>

/** Widen a skeleton into the full-findings shape (deep fields empty). */
export function skeletonToFindings(s: ScanSkeleton): ScanFindings {
  return {
    ...s,
    copy: [],
    coverageGaps: [],
    workflows: s.workflows.map(w => ({
      ...w,
      risks: [],
      interventions: [],
      signals: [],
    })),
  } as unknown as ScanFindings
}

export interface SkeletonSink {
  capture(skeleton: ScanSkeleton): void
  isCaptured(): boolean
}

export function makeSubmitSkeletonTool(sink: SkeletonSink) {
  return tool(
    'submitSkeleton',
    [
      'Submit the STRUCTURAL skeleton of the product as soon as it is coherent:',
      'product identity, routes, components, and workflows with only name,',
      'entryPages, steps, and bowtieStage. Call this EXACTLY ONCE, early —',
      'before the deep risk/intervention analysis. It publishes the first',
      'version of the journey map so the user sees it immediately. After it',
      'succeeds, CONTINUE the scan and finish with submitFindings as usual.',
    ].join(' '),
    ScanSkeletonSchema.shape,
    async (args) => {
      const parsed = ScanSkeletonSchema.safeParse(args)
      if (!parsed.success) {
        return {
          content: [{
            type: 'text' as const,
            text: `submitSkeleton rejected: ${parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}. Fix the payload and call again.`,
          }],
          isError: true,
        }
      }
      if (sink.isCaptured()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'submitSkeleton already received the skeleton. Continue the deep scan and finish with submitFindings.',
          }],
          isError: true,
        }
      }
      sink.capture(parsed.data)
      return {
        content: [{
          type: 'text' as const,
          text: 'Skeleton accepted and publishing. Continue the deep scan (risks, interventions, signals, copy, brand voice) and finish with submitFindings.',
        }],
      }
    },
  )
}
