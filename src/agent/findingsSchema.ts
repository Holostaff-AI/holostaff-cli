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
        steps: z.array(z.string()).min(1).describe('Ordered steps as the user experiences them, not as code paths.'),
        entryRoute: z.string().optional().describe('Where the workflow starts.'),
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
          .optional()
          .describe(
            'Bowtie customer-journey stage this workflow lives in. See the Bowtie stage taxonomy section of the system prompt for definitions. If you genuinely can\'t tell, omit it — the dashboard will fall back to a heuristic.',
          ),
      }),
    )
    .default([])
    .describe(
      'Multi-step user flows you can infer from routes + components + copy. Examples: signup, onboarding, billing, project creation. Skip flows you can only guess at.',
    ),

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
