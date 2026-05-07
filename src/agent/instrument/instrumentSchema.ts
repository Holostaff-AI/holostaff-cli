/**
 * InstrumentationPlan — what the agent submits via proposeEdits.
 *
 * Three operation kinds, narrow on purpose so dry-running and applying
 * are obvious:
 *
 *   - install  Add a runtime dep ('@holostaff/sdk') via the project's
 *              detected package manager (npm/pnpm/yarn).
 *   - edit     Replace one exact substring inside an existing file
 *              with a new substring. We use a unique-anchor model
 *              instead of line numbers because file contents drift
 *              between scan and apply.
 *   - create   Write a new file with the given content. Only used
 *              for tiny config / wrapper files (e.g. holostaff.ts).
 *
 * The agent also provides a one-paragraph rationale and a list of
 * coverage gaps (things it noticed but didn't address). Mirrors the
 * scan agent's "be honest about what you didn't reach" stance.
 */

import { z } from 'zod'

export const InstallOpSchema = z.object({
  kind: z.literal('install'),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).describe('Detected from lockfile.'),
  packages: z
    .array(z.string())
    .min(1)
    .describe('Package specs to install, e.g. ["@holostaff/sdk@^0.1.0"].'),
  dev: z.boolean().default(false).describe('Install as devDependency.'),
})
export type InstallOp = z.infer<typeof InstallOpSchema>

export const EditOpSchema = z.object({
  kind: z.literal('edit'),
  file: z.string().min(1).describe('Repo-relative path of the file to edit.'),
  oldText: z
    .string()
    .min(1)
    .describe(
      'Exact substring to replace. MUST appear in the file and MUST be unique. Include enough surrounding lines that no accidental match exists.',
    ),
  newText: z
    .string()
    .describe('Replacement text. May be empty (deletion) but typically wraps oldText with new imports + an init call.'),
  reason: z.string().min(1).describe('One sentence on why this edit is needed.'),
})
export type EditOp = z.infer<typeof EditOpSchema>

export const CreateOpSchema = z.object({
  kind: z.literal('create'),
  file: z.string().min(1).describe('Repo-relative path of the new file.'),
  content: z.string().describe('Full file content.'),
  reason: z.string().min(1).describe('Why this file is needed.'),
})
export type CreateOp = z.infer<typeof CreateOpSchema>

export const InstrumentOpSchema = z.discriminatedUnion('kind', [
  InstallOpSchema,
  EditOpSchema,
  CreateOpSchema,
])
export type InstrumentOp = z.infer<typeof InstrumentOpSchema>

export const InstrumentationPlanSchema = z.object({
  /**
   * What this plan is doing in one sentence — shown above the diff
   * preview. Tells the user what they're saying yes to.
   */
  summary: z
    .string()
    .min(1)
    .describe(
      'One-sentence summary of the integration. e.g. "Adds @holostaff/sdk and initializes it in src/main.ts before app mount."',
    ),
  /**
   * Sequence the user sees + we apply, in order. Install ops should
   * come first conventionally; the runner doesn't enforce ordering
   * but the diff renderer assumes plan.ops[0]'s install (if any) is
   * the entry point.
   */
  ops: z
    .array(InstrumentOpSchema)
    .min(1)
    .describe('Operations to perform, in apply order.'),
  /**
   * Honest list of things the agent noticed but didn't try to handle —
   * SSR considerations, framework-specific edge cases, alternate entry
   * points it skipped. Empty array is fine.
   */
  coverageGaps: z
    .array(z.string())
    .default([])
    .describe('Concerns or limitations the user should know about.'),
})
export type InstrumentationPlan = z.infer<typeof InstrumentationPlanSchema>
