/**
 * detectFramework — custom MCP tool that exposes our heuristic repo
 * detector to the scan agent.
 *
 * Why a custom tool instead of leaning on the SDK's Read/Glob/Grep:
 * detectRepo() does a single bounded walk and returns a structured
 * summary (packages, frameworks, languages, roles, multi-package
 * shape, source file count, notable dirs). Asking the model to
 * reconstruct that from raw file reads costs many round-trips and is
 * error-prone for monorepos. One call here gets the agent oriented
 * before it starts reading code.
 *
 * Scope: the tool is constructed bound to the scan's root directory.
 * The SDK runs MCP tools in the *parent* process (our process), so
 * `process.cwd()` here is the spike/CLI's cwd, NOT the agent's `cwd`
 * option. Passing the root in via the factory keeps the tool aligned
 * with whatever directory runScan() was given.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { detectRepo } from '../../detect/repo.js'

export function makeDetectFrameworkTool(rootDir: string) {
  return tool(
    'detectFramework',
    [
      'Detect frameworks, languages, and package layout of the repository being scanned.',
      'Returns a structured summary: each package.json found, its framework',
      '(vue3 / react / next / nuxt / svelte / astro / remix / express /',
      'firebase-functions / fastify / unknown), language (typescript / javascript),',
      'role (frontend / backend / shared / unknown), and overall repo shape',
      '(multi-package, source file count, notable top-level dirs).',
      '',
      'Call this ONCE at the start of a scan to orient yourself before reading',
      'individual files. The walk is bounded (default 5000 source files) so it',
      'is safe on large monorepos. Returns JSON.',
    ].join(' '),
    {
      maxFiles: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on the number of source files to count during the walk. Default 5000.'),
    },
    async (args) => {
      const detection = detectRepo(rootDir, { maxFiles: args.maxFiles })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(detection, null, 2),
          },
        ],
      }
    },
  )
}
