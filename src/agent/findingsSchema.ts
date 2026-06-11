/**
 * ScanFindings — the structured output the scan agent produces.
 *
 * Code-native shape: oriented around what we can actually extract from
 * source (route declarations, component files, i18n bundles). The
 * formal `KnowledgeArtifact` schema (server/.../knowledge/schema.ts)
 * was modeled around runtime-crawl signals (visualSignalHints, ctas
 * from rendered HTML, BowtieStageMap from inferred page intent) — we
 * can't produce those from code alone. A2.3 builds the mapper from
 * findings → artifact and decides whether to extend the artifact
 * schema or keep them parallel (PRD §13 Open Q4).
 *
 * Keep this lean: every field is something the agent will plausibly
 * fill in from a real repo. We widen as we hit gaps in real scans.
 */

import { z } from 'zod'

export const ScanFindingsSchema = z.object({
  productName: z
    .string()
    .min(1)
    .describe(
      'The product name as a customer would say it. Source: package.json `name`, README title, or the dominant brand string in copy. Strip framework noise like "@org/" prefixes if it makes the name clearer.',
    ),
  oneLineDescription: z
    .string()
    .min(1)
    .describe(
      'A single sentence that says what this product is. Source: package.json `description`, README first paragraph, or your inference from routes + components. Concrete and customer-facing — no marketing fluff.',
    ),
  primaryFramework: z
    .string()
    .describe(
      'The framework powering the user-facing surface. For monorepos pick the frontend package, not the backend. Use the framework name as detectFramework reported it.',
    ),
  language: z
    .enum(['typescript', 'javascript', 'mixed', 'unknown'])
    .describe('Dominant source language across the user-facing package.'),

  routes: z
    .array(
      z.object({
        path: z.string().describe('URL path. Use the literal route declaration, e.g. "/dashboard", "/projects/:id".'),
        description: z.string().describe('One sentence on what the page does for the user.'),
        file: z.string().optional().describe('Repo-relative path of the route declaration or page component, if known.'),
      }),
    )
    .default([])
    .describe(
      'User-facing routes. Source: file-based routing dirs (pages/, app/, src/pages/) or declared route configs (vue-router, react-router). Only include routes a customer would visit — internal API routes go in `notes` if anywhere.',
    ),

  components: z
    .array(
      z.object({
        name: z.string().describe('Component name as it appears in code, e.g. "AppHeader", "ProjectCard".'),
        role: z
          .string()
          .describe(
            'Free-form role: "navigation header", "auth form", "pricing card", "settings dialog". Use customer-language not framework-language ("dashboard sidebar" not "VLayoutNav").',
          ),
        file: z.string().optional().describe('Repo-relative path.'),
      }),
    )
    .default([])
    .describe('A representative sample of top-level components — 8 to 15 typically. Don\'t catalogue everything.'),

  copy: z
    .array(
      z.object({
        text: z.string().describe('The literal string the customer sees.'),
        location: z.string().describe('Where it lives — file path, component, or i18n key.'),
      }),
    )
    .default([])
    .describe(
      'Customer-facing strings: hero copy, CTAs, empty states, error messages, onboarding prompts. Pull from i18n files first (locales/, translations/) — they\'re the gold standard. Inline literals are a fallback. 10–30 entries; favour the most prominent.',
    ),

  brandVoice: z
    .object({
      tone: z
        .string()
        .describe('Adjectives that describe how this product talks: "friendly + technical", "warm + plainspoken", "formal + concise".'),
      keywords: z
        .array(z.string())
        .default([])
        .describe('Vocabulary the product uses repeatedly — domain nouns, verb choices.'),
      avoidTerms: z
        .array(z.string())
        .default([])
        .describe('Terms the product avoids, where evident. Often empty.'),
    })
    .optional()
    .describe('Tonal signals from copy. Skip if there isn\'t enough copy to infer it honestly.'),

  workflows: z
    .array(
      z.object({
        name: z.string().describe('Customer-language name: "Sign up", "Create a project", "Invite a teammate".'),
        risks: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .describe('Stable id. Convention: `risk_<subStep>_<kind>_<terse>`, e.g. "risk_5b_stall_apikeys".'),
              kind: z
                .enum(['stall', 'error', 'churn'])
                .describe('Risk family: stall (user dwells/hesitates), error (something failed), churn (user about to leave).'),
              anchor: z
                .object({
                  kind: z.literal('step').describe('Step-anchored — the risk fires when the user is ON this step.'),
                  stepIndex: z
                    .number()
                    .int()
                    .min(0)
                    .describe('Zero-based index into this workflow\'s `steps` array.'),
                })
                .describe('Where in the journey the risk fires. v1 supports step-anchored only; edge-anchored is deferred.'),
              signal: z
                .string()
                .min(1)
                .describe('Observable signal in human terms. Lift verbatim or near-verbatim from the framework\'s "Observable signal" column. Examples: "dwell > 30s without scroll", "form abandoned", "3rd error in 60s".'),
              label: z
                .string()
                .min(1)
                .describe('Short human description of the risk for the canvas card. 1 line, customer-language. NOT a sub-step code.'),
              subStep: z
                .string()
                .min(2)
                .max(3)
                .optional()
                .describe('Framework sub-step id (e.g. "5b") this risk maps onto. Recommended — it lets the dashboard link the risk back to the framework row.'),
            }),
          )
          .default([])
          .describe('Risks the copilot should watch for on this workflow. See the risk + intervention section of the system prompt for the full method.'),
        interventions: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .describe('Stable id. Convention: `int_<subStep>_<modality>`, e.g. "int_5b_text".'),
              riskId: z
                .string()
                .min(1)
                .describe('Must match the `id` of one of this workflow\'s `risks[]`. 1:1 for v1 — chains deferred.'),
              modality: z
                .enum([
                  'text',
                  'voice_presentation',
                  'screen_automation',
                  'email',
                  'sms',
                  'phone',
                  'silence',
                ])
                .describe('How the copilot intervenes. Pick the LEAST invasive modality that can do the job. `silence` is a deliberate "no intervention" — used when the right move is to stay quiet.'),
              content: z
                .string()
                .describe('Script / copy / action spec. Empty string OK only for `silence` (where the body should explain WHY no intervention).'),
              goal: z
                .string()
                .min(1)
                .describe('One-line goal: what transition does this intervention enable? Reference the sub-step jump, e.g. "Get the user past 5b → 5c".'),
              returnsToStep: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Optional: zero-based index of the step the user resumes on after the intervention. Omit for shadow-terminal interventions (email follow-up after the user has left, expansion outreach).'),
            }),
          )
          .default([])
          .describe('Copilot interventions designed against the risks above. Each one MUST reference an existing risk via `riskId`.'),
        steps: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('step').describe('A single user action (click, fill form, etc). NOT a page-arrival — use "page" for those.'),
                text: z.string().describe('What the user does at this step, in customer language.'),
              }),
              z.object({
                kind: z.literal('page').describe('The user is on / arrives at a specific page. Use this instead of "step" whenever the moment is about being-on-a-page rather than an action.'),
                text: z.string().describe('What the user does or sees on this page, in customer language.'),
                route: z.string().describe('The page route (e.g. "/pricing", "/signup"). Required.'),
              }),
              z.object({
                kind: z.literal('decision').describe('A branch point where the user is sorted onto different paths.'),
                question: z.string().describe('The question that determines which path the user takes. End with "?".'),
                outcomes: z
                  .array(
                    z.object({
                      label: z.string().describe('Outcome label, e.g. "Yes", "No", "Free plan", "Enterprise plan".'),
                      goesTo: z
                        .number()
                        .int()
                        .nullable()
                        .optional()
                        .describe('Zero-based index of the next step this outcome leads to. Omit if unknown or terminal.'),
                    }),
                  )
                  .min(2)
                  .describe('Possible outcomes of the decision. Always at least two.'),
              }),
              z.object({
                kind: z.literal('outcome').describe('A terminal marker — the workflow ends here.'),
                label: z.string().describe('Outcome label, e.g. "Signed up", "Abandoned", "Plan upgraded".'),
                result: z
                  .enum(['converted', 'dropped'])
                  .describe('"converted" = user reached the desired end-state; "dropped" = user abandoned the flow.'),
              }),
              z.object({
                kind: z.literal('modal').describe('A modal / overlay step — the user can dismiss it and continue.'),
                text: z.string().describe('What the modal asks of the user.'),
              }),
            ]),
          )
          .min(1)
          .describe(
            'Ordered steps the user experiences. Use the kind discriminator: "page" for page-arrival moments (specific route), "step" for actions taken (click, fill form), "decision" when the flow forks on a question, "outcome" to mark a terminal success/drop, "modal" for overlay UI. Alternate naturally between "page" and "step" — a typical sign-up flow is page→step→page→step→outcome.',
          ),
        entryPages: z
          .array(
            z.object({
              route: z.string().describe('Page route, e.g. "/", "/pricing".'),
              text: z.string().optional().describe('Optional context: "Sign-up CTA in the hero", "Footer link".'),
            }),
          )
          .min(1)
          .describe(
            'Page(s) the user is on when this workflow can begin. REQUIRED. List EVERY real surface the user would intentionally use to start this flow — not every page that happens to link to it. Most workflows have 1 entry; flows like Sign-up, Search, or Add-to-cart often have several.',
          ),
        bowtieStage: z
          .enum([
            'awareness',
            'education',
            'selection',
            'mutual_commit',
            'onboarding',
            'adoption',
            'expansion',
          ])
          .describe(
            'Bowtie customer-journey stage this workflow lives in. REQUIRED. See the Bowtie stage taxonomy section of the system prompt for definitions. The dashboard does NOT heuristically classify — your decision is final. When unsure between two stages, pick the LATER one in the bowtie order.',
          ),
        signals: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .describe('Signal name from the custom-signal taxonomy (lowercase snake_case, past tense). MUST be a taxonomy name — invented names will never match a risk. Example: "sign_up_completed".'),
              stepIndex: z
                .number()
                .int()
                .min(0)
                .describe('Zero-based index of the workflow step where this host-app event fires.'),
              file: z
                .string()
                .optional()
                .describe('Repo-relative file where the event handler lives, when you can see it. Lets the deploy PR place the emitSignal probe.'),
              note: z
                .string()
                .optional()
                .describe('One line: which host-app event this maps to, e.g. "fires on Stripe checkout success callback".'),
            }),
          )
          .default([])
          .describe('Host-app events on this workflow that map to the custom-signal taxonomy. See the signal taxonomy section of the system prompt. Skip events with no taxonomy match — list them in `notes` as candidates instead.'),
      }),
    )
    .default([])
    .describe(
      'Multi-step user flows you can infer from routes + components + copy. Examples: signup, onboarding, billing, project creation. Skip flows you can only guess at.',
    ),

  identitySurfaces: z
    .array(
      z.object({
        kind: z
          .enum(['sign_in_complete', 'sign_out'])
          .describe('"sign_in_complete" → an identify() call belongs here; "sign_out" → clearIdentity().'),
        file: z
          .string()
          .min(1)
          .describe('Repo-relative file holding the auth completion / sign-out handler.'),
        component: z
          .string()
          .optional()
          .describe('Component or function name inside the file, when identifiable.'),
        note: z
          .string()
          .optional()
          .describe('One line on how auth completes here, e.g. "Firebase onAuthStateChanged in the root store".'),
      }),
    )
    .default([])
    .describe('Where the app completes sign-in / sign-out. Report surfaces the route-name heuristic would miss: OAuth callbacks, auth-state listeners, custom-named routes. The deploy PR ships a commented identify()/clearIdentity() skeleton at each.'),

  coverageGaps: z
    .array(z.string())
    .default([])
    .describe(
      'Explicit list of things you did NOT analyze: dirs you skipped, files you couldn\'t parse, areas you couldn\'t reason about. Honesty here is non-optional — better to declare a gap than to fabricate a finding.',
    ),

  notes: z
    .string()
    .optional()
    .describe('Any free-form context that doesn\'t fit elsewhere but informs how this artifact should be used.'),
})

export type ScanFindings = z.infer<typeof ScanFindingsSchema>
