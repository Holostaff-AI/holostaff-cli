/**
 * A2.0 — Azure AI Foundry + Claude Agent SDK compatibility spike.
 *
 * Answers PRD §13 Open Question 1: does the Claude Agent SDK work
 * against Azure's Anthropic-compatible endpoint, and if not, does the
 * raw Anthropic SDK fall-back path work?
 *
 * Two tests, each runs independently:
 *
 *   Path A — raw @anthropic-ai/sdk with baseURL override.
 *   Smallest possible call: messages.create({ model, prompt }).
 *   Failure here means the wire itself is wrong (wrong URL shape,
 *   wrong auth header, wrong API version, wrong model id) — fix
 *   that before anything else.
 *
 *   Path B — @anthropic-ai/claude-agent-sdk's query() with env vars
 *   plumbed through to the subprocess. The Agent SDK wraps the
 *   Claude Code CLI binary, which honours ANTHROPIC_BASE_URL and
 *   ANTHROPIC_API_KEY. Failure here when A passed means we need a
 *   thin custom agent loop on the raw SDK (PRD §5.2 fallback).
 *
 * Required env:
 *   AZURE_ANTHROPIC_ENDPOINT — base URL up to /anthropic, e.g.
 *     https://automi-sweden-resource.services.ai.azure.com/anthropic
 *     (the SDK appends /v1/messages itself)
 *   AZURE_ANTHROPIC_API_KEY — Azure-issued key sent as x-api-key
 *
 * Run:  cd cli && npm run spike:azure
 */

import Anthropic from '@anthropic-ai/sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'

const MODEL = process.env.AZURE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
const PROMPT = 'Reply with exactly the word: pong.'

function need(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`✗ Missing required env: ${name}`)
    console.error(`  Set it then re-run. See cli/src/spike/azureSpike.ts header for details.`)
    process.exit(2)
  }
  return v
}

function header(label: string) {
  console.log('\n' + '─'.repeat(64))
  console.log(label)
  console.log('─'.repeat(64))
}

async function pathA(baseURL: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  header('Path A — @anthropic-ai/sdk with baseURL override')
  console.log(`  baseURL: ${baseURL}`)
  console.log(`  model:   ${MODEL}`)

  try {
    const client = new Anthropic({ baseURL, apiKey })
    const t0 = Date.now()
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: PROMPT }],
    })
    const ms = Date.now() - t0
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
    console.log(`  ✓ HTTP 200 in ${ms}ms`)
    console.log(`  ✓ stop_reason: ${res.stop_reason}`)
    console.log(`  ✓ usage: in=${res.usage.input_tokens} out=${res.usage.output_tokens}`)
    console.log(`  ✓ text: ${JSON.stringify(text)}`)
    return { ok: true, detail: `${ms}ms, "${text}"` }
  } catch (err: any) {
    console.log(`  ✗ FAILED: ${err?.status ?? ''} ${err?.message ?? err}`)
    if (err?.error) console.log(`    error body: ${JSON.stringify(err.error).slice(0, 400)}`)
    return { ok: false, detail: err?.message ?? String(err) }
  }
}

async function pathB(baseURL: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  header('Path B — Claude Agent SDK with Foundry mode (CLAUDE_CODE_USE_FOUNDRY=1)')
  console.log(`  ANTHROPIC_FOUNDRY_BASE_URL: ${baseURL}`)
  console.log(`  model alias:                sonnet → ${MODEL}`)

  try {
    const t0 = Date.now()
    const q = query({
      // The Foundry path resolves the model from the alias 'sonnet' via
      // ANTHROPIC_DEFAULT_SONNET_MODEL — passing a literal model id here
      // would bypass that mapping. Use the alias.
      prompt: PROMPT,
      options: {
        model: 'sonnet',
        tools: [],
        maxTurns: 1,
        // Foundry-specific env vars per
        // https://code.claude.com/docs/en/microsoft-foundry. The Agent
        // SDK forwards these to the Claude Code subprocess, which has
        // a built-in Foundry adapter that signs requests correctly.
        env: {
          ...process.env,
          CLAUDE_CODE_USE_FOUNDRY: '1',
          ANTHROPIC_FOUNDRY_BASE_URL: baseURL,
          ANTHROPIC_FOUNDRY_API_KEY: apiKey,
          ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'holostaff-cli/spike',
          // Make sure no stray non-Foundry creds confuse the adapter.
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          ANTHROPIC_BASE_URL: undefined,
        },
      },
    })

    let assistantText = ''
    let stopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0

    for await (const msg of q) {
      // The Agent SDK emits a stream of typed messages. We only care
      // about assistant content + the final result here.
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') assistantText += block.text
        }
      } else if (msg.type === 'result') {
        stopReason = (msg as any).subtype ?? (msg as any).stop_reason
        const u = (msg as any).usage ?? {}
        inputTokens = u.input_tokens ?? 0
        outputTokens = u.output_tokens ?? 0
      }
    }

    const ms = Date.now() - t0
    console.log(`  ✓ stream completed in ${ms}ms`)
    if (stopReason) console.log(`  ✓ result subtype: ${stopReason}`)
    console.log(`  ✓ usage: in=${inputTokens} out=${outputTokens}`)
    console.log(`  ✓ assistant text: ${JSON.stringify(assistantText.trim())}`)
    return { ok: assistantText.trim().length > 0, detail: `${ms}ms, "${assistantText.trim()}"` }
  } catch (err: any) {
    console.log(`  ✗ FAILED: ${err?.message ?? err}`)
    if (err?.stack) console.log(err.stack.split('\n').slice(0, 4).join('\n'))
    return { ok: false, detail: err?.message ?? String(err) }
  }
}

async function main() {
  const baseURL = need('AZURE_ANTHROPIC_ENDPOINT').replace(/\/+$/, '')
  const apiKey = need('AZURE_ANTHROPIC_API_KEY')

  console.log('Holostaff CLI — Azure AI Foundry compatibility spike (A2.0)')

  const a = await pathA(baseURL, apiKey)
  const b = await pathB(baseURL, apiKey)

  header('Summary')
  console.log(`  Path A (raw SDK):   ${a.ok ? 'PASS' : 'FAIL'}  — ${a.detail}`)
  console.log(`  Path B (Agent SDK): ${b.ok ? 'PASS' : 'FAIL'}  — ${b.detail}`)
  console.log()
  if (a.ok && b.ok) {
    console.log('  → Recommended path: Claude Agent SDK (Path B).')
    console.log('    Tool-use + permission primitives come for free; env-var override is clean.')
  } else if (a.ok && !b.ok) {
    console.log('  → Fallback path: raw Anthropic SDK (Path A) + thin agent loop.')
    console.log('    Wire works; Agent SDK either errors or drops the override.')
  } else if (!a.ok && b.ok) {
    console.log('  → Surprising: Agent SDK works but raw SDK does not. Re-check Path A baseURL/headers.')
  } else {
    console.log('  → BLOCKED: neither path works. Check Azure deployment, API key, and PRD §5.2 endpoint.')
  }

  process.exit(a.ok || b.ok ? 0 : 1)
}

main().catch((err) => {
  console.error('\nspike: unexpected error:', err?.message ?? err)
  process.exit(1)
})
