/**
 * Agent tools — exports the factory for our root-bound detectFramework
 * tool, the qualified tool names, and the curated allowlist of SDK
 * built-ins the scan agent uses.
 *
 * No static MCP server export: each scan run constructs its own
 * server (see runScan) because submitFindings's handler closes over
 * a per-run findings sink. detectFramework is also per-run so it can
 * inspect the scan's target directory rather than the parent
 * process's cwd.
 */

export { makeDetectFrameworkTool } from './detectFramework.js'

const SERVER_NAME = 'holostaff'

/** Qualified tool names as they appear to the agent after MCP registration. */
export const DETECT_FRAMEWORK_TOOL = `mcp__${SERVER_NAME}__detectFramework`
export const SUBMIT_FINDINGS_TOOL = `mcp__${SERVER_NAME}__submitFindings`

/**
 * Built-in tools the scan agent is allowed to use. Passed to the SDK's
 * `tools` option to *restrict* the catalog (otherwise the full Claude
 * Code preset — Bash, Edit, Write, Web*, etc. — is visible). Read-only
 * by design.
 */
export const SCAN_BUILTIN_TOOLS: string[] = ['Read', 'Glob', 'Grep']

/**
 * Auto-approval allowlist for the scan agent. Includes the built-ins
 * above plus our MCP tools, so they all run without a permission
 * prompt. The SDK still gates writes / shell / network at the tool
 * layer because none of those are advertised in `SCAN_BUILTIN_TOOLS`.
 */
export const SCAN_ALLOWED_TOOLS: string[] = [
  ...SCAN_BUILTIN_TOOLS,
  DETECT_FRAMEWORK_TOOL,
  SUBMIT_FINDINGS_TOOL,
]
