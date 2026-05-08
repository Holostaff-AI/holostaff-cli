/**
 * runScan — drives the Claude Agent SDK loop for /scan.
 *
 * Caller supplies a working directory and an event sink. We:
 *   - configure the SDK with the scan system prompt + tool allowlist
 *   - wire the in-process MCP server (detectFramework, submitFindings)
 *   - stream the agent's messages, emitting typed ScanEvent updates
 *   - capture the structured findings the agent submits
 *   - return a ScanResult after the stream ends
 *
 * Auth is brought in via env at the call site (see buildAgentEnv).
 * Today that's BYO Azure key; PRD §13.10 tracks the production model
 * key delivery question.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import { makeDetectFrameworkTool } from './tools/detectFramework.js'
import { makeSubmitFindingsTool, type FindingsSink } from './tools/submitFindings.js'
import { SCAN_ALLOWED_TOOLS, SCAN_BUILTIN_TOOLS } from './tools/index.js'
import type { ScanFindings } from './findingsSchema.js'
import { SCAN_SYSTEM_PROMPT } from './scanPrompt.js'

export type ScanEvent =
  | { type: 'started'; cwd: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; isError: boolean; preview: string }
  | { type: 'submitted' }
  | { type: 'completed'; result: ScanResult }
  | { type: 'failed'; error: string }

export type ScanResult =
  | {
      ok: true
      findings: ScanFindings
      sessionId: string | undefined
      durationMs: number
      tokens: { input: number; output: number }
    }
  | {
      ok: false
      reason: 'no_findings_submitted' | 'agent_error' | 'aborted'
      error: string
      sessionId: string | undefined
      durationMs: number
    }

export interface RunScanOptions {
  /** Repository root the agent should reason about. */
  cwd: string
  /** Stream of agent activity for UI/logs. */
  onEvent?: (event: ScanEvent) => void
  /** Cancel the scan early. */
  abortController?: AbortController
  /**
   * Cap on agent turns. Each tool call + response is one turn. 30 is
   * comfortable for a small/medium repo; raise for monorepos.
   */
  maxTurns?: number
  /**
   * Env passed to the Claude Code subprocess. Use buildAgentEnv() to
   * construct the standard Foundry-mode set; pass through directly
   * for tests or alternate transports.
   */
  env: Record<string, string | undefined>
}

export async function runScan(options: RunScanOptions): Promise<ScanResult> {
  const { cwd, onEvent, abortController, maxTurns = 30, env } = options

  // Findings sink — submitFindings handler writes here exactly once.
  let captured: ScanFindings | undefined
  const sink: FindingsSink = {
    capture: (f) => {
      captured = f
      onEvent?.({ type: 'submitted' })
    },
    isCaptured: () => captured !== undefined,
  }

  const submitFindingsTool = makeSubmitFindingsTool(sink)
  const detectFrameworkTool = makeDetectFrameworkTool(cwd)

  // Build the MCP server fresh per scan. detectFramework closes over
  // the scan's cwd, and submitFindings over a run-scoped sink — so
  // sharing the server across runs would either misreport the root
  // or tangle findings between scans.
  const mcpServer = createSdkMcpServer({
    name: 'holostaff',
    version: '0.1.0',
    tools: [detectFrameworkTool, submitFindingsTool],
  })

  onEvent?.({ type: 'started', cwd })

  const t0 = Date.now()
  let sessionId: string | undefined
  let inputTokens = 0
  let outputTokens = 0

  try {
    const q = query({
      prompt: 'Begin the scan now. Follow the method in your system prompt and call submitFindings once you have the artifact.',
      options: {
        cwd,
        model: 'sonnet',
        systemPrompt: SCAN_SYSTEM_PROMPT,
        mcpServers: { holostaff: mcpServer },
        // tools: restrict the built-in catalog. Without this, the model
        // sees Bash / Edit / Write / Web* and tries them — the SDK
        // sandbox blocks them but the agent wastes turns reaching.
        tools: SCAN_BUILTIN_TOOLS,
        // allowedTools: auto-approve the read-only set + our MCP tools.
        allowedTools: SCAN_ALLOWED_TOOLS,
        // Pin the binary path explicitly — see resolveClaudeBinary().
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        maxTurns,
        abortController,
        env,
      },
    })

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = (msg as { session_id?: string }).session_id
        continue
      }

      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            onEvent?.({ type: 'thinking', text: block.text })
          } else if (block.type === 'tool_use') {
            onEvent?.({
              type: 'tool_use',
              tool: block.name,
              input: block.input,
            })
          }
        }
        continue
      }

      if (msg.type === 'user') {
        // The SDK emits tool results under the user role per the
        // Anthropic message protocol. Surface a brief preview so the
        // UI can show "Read X.vue (4kb)" without dumping payload.
        for (const block of msg.message.content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const tr = block as { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
            const preview = previewOf(tr.content)
            onEvent?.({
              type: 'tool_result',
              tool: tr.tool_use_id, // SDK doesn't echo the tool name on results — id is what we have
              isError: Boolean(tr.is_error),
              preview,
            })
          }
        }
        continue
      }

      if (msg.type === 'result') {
        const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {}
        inputTokens = u.input_tokens ?? 0
        outputTokens = u.output_tokens ?? 0
      }
    }

    const durationMs = Date.now() - t0

    if (captured) {
      const result: ScanResult = {
        ok: true,
        findings: captured,
        sessionId,
        durationMs,
        tokens: { input: inputTokens, output: outputTokens },
      }
      onEvent?.({ type: 'completed', result })
      return result
    }

    const result: ScanResult = {
      ok: false,
      reason: 'no_findings_submitted',
      error:
        'The agent ended without calling submitFindings. This usually means it hit maxTurns before completing the scan, or got confused about the artifact shape. Re-run with a higher maxTurns or simplify the repo.',
      sessionId,
      durationMs,
    }
    onEvent?.({ type: 'completed', result })
    return result
  } catch (err: unknown) {
    const durationMs = Date.now() - t0
    const message = err instanceof Error ? err.message : String(err)
    const aborted = abortController?.signal.aborted ?? false
    onEvent?.({ type: 'failed', error: message })
    return {
      ok: false,
      reason: aborted ? 'aborted' : 'agent_error',
      error: message,
      sessionId,
      durationMs,
    }
  }
}

function previewOf(content: unknown): string {
  if (typeof content === 'string') return truncate(content, 160)
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        typeof b === 'object' && b !== null && 'type' in b && (b as { type: string }).type === 'text'
          ? (b as { text?: string }).text ?? ''
          : '',
      )
      .join('')
    return truncate(text, 160)
  }
  return ''
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

/**
 * Locate the bundled Claude Code binary the Agent SDK shells out to.
 *
 * The SDK ships several platform-specific optional deps — on Linux,
 * both glibc (`claude-agent-sdk-linux-x64`) and musl variants exist.
 * Its built-in libc detection has been observed to pick the wrong one
 * on some systems (it grabs musl on Debian glibc), so we resolve the
 * path ourselves and hand it to the SDK via `pathToClaudeCodeExecutable`.
 *
 * Returns undefined when no installed variant matches the current
 * platform — caller should fall back to the SDK's default resolution
 * and surface the SDK's error message if it can't find one either.
 */
export function resolveClaudeBinary(): string | undefined {
  // node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs is the SDK's
  // entry; the binary peers it as a sibling subpackage.
  const here = fileURLToPath(import.meta.url)
  const root = findPackageRoot(dirname(here))
  if (!root) return undefined

  const candidates: Array<[NodeJS.Platform, string, string]> = [
    ['linux',  'x64',   'claude-agent-sdk-linux-x64/claude'],
    ['darwin', 'arm64', 'claude-agent-sdk-darwin-arm64/claude'],
    ['darwin', 'x64',   'claude-agent-sdk-darwin-x64/claude'],
    ['win32',  'x64',   'claude-agent-sdk-win32-x64/claude.exe'],
  ]
  for (const [plat, arch, rel] of candidates) {
    if (process.platform !== plat || process.arch !== arch) continue
    const full = join(root, 'node_modules', '@anthropic-ai', rel)
    if (existsSync(full)) return full
  }
  return undefined
}

function findPackageRoot(start: string): string | undefined {
  // Walk up until we find the cli package.json — the directory above
  // it is where node_modules/@anthropic-ai lives.
  let dir = start
  while (dir && dir !== '/' && dir !== '.') {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules', '@anthropic-ai'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Build the env dict the Agent SDK forwards to its Claude Code
 * subprocess. Resolves Azure Foundry credentials from one of:
 *   1. local env vars (BYO key — preserved for development)
 *   2. POST /api/cli/model-session against the user's authed workspace
 *      (production path — server holds the Foundry key as a Cloud Run
 *      secret and hands a 1h-TTL bundle to authed callers, cached in
 *      memory for the rest of the process).
 *
 * Returns null only if BOTH sources are unavailable — in which case
 * the caller surfaces a targeted error before kicking off a long
 * scan.
 */
export async function buildAgentEnv(): Promise<Record<string, string | undefined> | null> {
  const session = await resolveModelSession()
  if (!session) return null

  return {
    ...process.env,
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_FOUNDRY_BASE_URL: session.endpoint,
    ANTHROPIC_FOUNDRY_API_KEY: session.apiKey,
    ANTHROPIC_DEFAULT_SONNET_MODEL: session.model,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'holostaff-cli',
    // Make absolutely sure no stray non-Foundry creds confuse the adapter.
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
  }
}

interface ModelSession {
  endpoint: string
  apiKey: string
  model: string
  /** ms-since-epoch when the cached session expires; 0 for env-source. */
  expiresAtMs: number
}

let cachedSession: ModelSession | null = null

/**
 * Resolve a Foundry creds bundle. Prefers env (developer mode) and
 * falls back to a server-minted session. Caches the server result
 * with a 10-minute safety margin against the server-stamped TTL.
 */
async function resolveModelSession(): Promise<ModelSession | null> {
  // 1. BYO env — local development takes precedence so devs aren't
  //    blocked by network or auth state.
  const envEndpoint = process.env.AZURE_ANTHROPIC_ENDPOINT?.replace(/\/+$/, '')
  const envApiKey = process.env.AZURE_ANTHROPIC_API_KEY
  if (envEndpoint && envApiKey) {
    return {
      endpoint: envEndpoint,
      apiKey: envApiKey,
      model: process.env.AZURE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      expiresAtMs: 0,
    }
  }

  // 2. Cached session — refresh if within 10 minutes of the server-
  //    stamped expiry, since a long scan can outlive a tight TTL.
  const now = Date.now()
  if (cachedSession && cachedSession.expiresAtMs - now > 10 * 60 * 1000) {
    return cachedSession
  }

  // 3. Mint from the server. Requires an authed CLI session.
  const { resolveAuth } = await import('../auth/credentials.js')
  const auth = resolveAuth()
  if (auth.source === 'none' || auth.expired || !auth.token) return null

  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/model-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { endpoint?: string; apiKey?: string; model?: string; expiresAt?: string }
    if (!body.endpoint || !body.apiKey || !body.model) return null
    cachedSession = {
      endpoint: body.endpoint.replace(/\/+$/, ''),
      apiKey: body.apiKey,
      model: body.model,
      expiresAtMs: body.expiresAt ? Date.parse(body.expiresAt) : now + 60 * 60 * 1000,
    }
    return cachedSession
  } catch {
    return null
  }
}
