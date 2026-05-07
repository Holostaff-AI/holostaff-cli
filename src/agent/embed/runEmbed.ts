/**
 * runEmbed — drives the Claude Agent SDK loop for /embed.
 *
 * Mirrors runInstrument: same plan shape, same exit-tool factory, same
 * read-only tool set. Differences are the system prompt and the
 * specific tool name the agent uses to submit (proposeEmbedPlan vs.
 * proposeInstrumentationPlan) so the prompts can name the tool
 * unambiguously.
 */

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import { makeDetectFrameworkTool } from '../tools/detectFramework.js'
import { buildAgentEnv, resolveClaudeBinary } from '../runScan.js'
import { EMBED_SYSTEM_PROMPT } from './embedPrompt.js'
import {
  makeProposePlanTool,
  type InstrumentationSink,
} from '../instrument/proposeTool.js'
import type { InstrumentationPlan } from '../instrument/instrumentSchema.js'

export type EmbedEvent =
  | { type: 'started'; cwd: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; isError: boolean; preview: string }
  | { type: 'submitted' }
  | { type: 'completed'; result: EmbedResult }
  | { type: 'failed'; error: string }

export type EmbedResult =
  | {
      ok: true
      plan: InstrumentationPlan
      sessionId: string | undefined
      durationMs: number
      tokens: { input: number; output: number }
    }
  | {
      ok: false
      reason: 'no_plan_submitted' | 'agent_error' | 'aborted' | 'env_missing'
      error: string
      sessionId: string | undefined
      durationMs: number
    }

export interface RunEmbedOptions {
  cwd: string
  onEvent?: (event: EmbedEvent) => void
  abortController?: AbortController
  maxTurns?: number
}

export async function runEmbed(options: RunEmbedOptions): Promise<EmbedResult> {
  const { cwd, onEvent, abortController, maxTurns = 20 } = options

  const env = buildAgentEnv()
  if (!env) {
    const result: EmbedResult = {
      ok: false,
      reason: 'env_missing',
      error: 'Missing AZURE_ANTHROPIC_ENDPOINT or AZURE_ANTHROPIC_API_KEY. Set them in your shell and re-run.',
      sessionId: undefined,
      durationMs: 0,
    }
    onEvent?.({ type: 'failed', error: result.error })
    return result
  }

  let captured: InstrumentationPlan | undefined
  const sink: InstrumentationSink = {
    capture: (p) => {
      captured = p
      onEvent?.({ type: 'submitted' })
    },
    isCaptured: () => captured !== undefined,
  }

  const proposeTool = makeProposePlanTool({
    name: 'proposeEmbedPlan',
    description: [
      'Submit the proposed embed patch. Call this EXACTLY ONCE once you\'ve',
      'drafted a complete plan. Args are validated; if validation fails, fix',
      'the payload and call again. After submitting, the run is over.',
    ].join(' '),
    sink,
    runLabel: '/embed',
  })
  const detectFrameworkTool = makeDetectFrameworkTool(cwd)
  const mcpServer = createSdkMcpServer({
    name: 'holostaff',
    version: '0.1.0',
    tools: [detectFrameworkTool, proposeTool],
  })

  const allowedTools = [
    'Read',
    'Glob',
    'Grep',
    'mcp__holostaff__detectFramework',
    'mcp__holostaff__proposeEmbedPlan',
  ]

  onEvent?.({ type: 'started', cwd })

  const t0 = Date.now()
  let sessionId: string | undefined
  let inputTokens = 0
  let outputTokens = 0

  try {
    const q = query({
      prompt:
        'Begin /embed now. Follow the method in your system prompt and call proposeEmbedPlan once you have a complete plan.',
      options: {
        cwd,
        model: 'sonnet',
        systemPrompt: EMBED_SYSTEM_PROMPT,
        mcpServers: { holostaff: mcpServer },
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools,
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
            onEvent?.({ type: 'tool_use', tool: block.name, input: block.input })
          }
        }
        continue
      }
      if (msg.type === 'user') {
        for (const block of msg.message.content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const tr = block as { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
            const preview = previewOf(tr.content)
            onEvent?.({ type: 'tool_result', tool: tr.tool_use_id, isError: Boolean(tr.is_error), preview })
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
      const result: EmbedResult = {
        ok: true,
        plan: captured,
        sessionId,
        durationMs,
        tokens: { input: inputTokens, output: outputTokens },
      }
      onEvent?.({ type: 'completed', result })
      return result
    }
    const result: EmbedResult = {
      ok: false,
      reason: 'no_plan_submitted',
      error: 'The agent ended without submitting an embed plan. Re-run with a higher maxTurns or in a smaller package.',
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
