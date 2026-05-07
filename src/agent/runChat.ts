/**
 * runChat — single-turn conversational query against the Claude Agent
 * SDK, with optional session resume for multi-turn continuity.
 *
 * Caller passes the user's prompt and (optionally) the session id from
 * a prior turn; we yield assistant text deltas as they arrive so the
 * UI can stream the response into a scrolling chat view.
 *
 * Pure model conversation — no tools, no permission gates, no MCP
 * servers. Slash commands handle every action that touches the
 * filesystem or the Holostaff API.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { CHAT_SYSTEM_PROMPT } from './chatPrompt.js'
import { buildAgentEnv, resolveClaudeBinary } from './runScan.js'

export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'completed'; sessionId: string | undefined; tokens: { input: number; output: number } }
  | { type: 'failed'; error: string }

export interface RunChatOptions {
  prompt: string
  /** Resume a prior session id to keep context across turns. */
  resume?: string
  /** Cancel the request mid-flight. */
  abortController?: AbortController
  /** Stream of events for the UI. */
  onEvent?: (ev: ChatEvent) => void
}

export async function runChat(options: RunChatOptions): Promise<void> {
  const env = buildAgentEnv()
  if (!env) {
    options.onEvent?.({
      type: 'failed',
      error:
        'Missing AZURE_ANTHROPIC_ENDPOINT or AZURE_ANTHROPIC_API_KEY in your shell. Chat needs the model API; production CLI distribution will fetch a session-scoped model key from your workspace (PRD §13.10).',
    })
    return
  }

  let sessionId: string | undefined = options.resume

  try {
    const q = query({
      prompt: options.prompt,
      options: {
        model: 'sonnet',
        systemPrompt: CHAT_SYSTEM_PROMPT,
        // No tools, no MCP servers, no permission gates — pure
        // conversation. The slash command layer owns actions.
        tools: [],
        maxTurns: 1,
        resume: options.resume,
        abortController: options.abortController,
        pathToClaudeCodeExecutable: resolveClaudeBinary(),
        env,
      },
    })

    let inputTokens = 0
    let outputTokens = 0

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && !sessionId) {
        sessionId = (msg as { session_id?: string }).session_id
        if (sessionId) options.onEvent?.({ type: 'session', sessionId })
        continue
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.length > 0) {
            options.onEvent?.({ type: 'delta', text: block.text })
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

    options.onEvent?.({
      type: 'completed',
      sessionId,
      tokens: { input: inputTokens, output: outputTokens },
    })
  } catch (err: unknown) {
    options.onEvent?.({
      type: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
