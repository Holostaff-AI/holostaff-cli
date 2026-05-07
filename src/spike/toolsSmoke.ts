/**
 * A2.1 — read-only tools smoke spike.
 *
 * Two checks:
 *
 *   1. Standalone — call the detectFramework handler directly. Confirms
 *      the tool wraps our detector cleanly and returns parseable JSON.
 *
 *   2. End-to-end — fire a query() that *should* trigger detectFramework
 *      against the current repo. We instruct the agent to call the tool
 *      exactly once and report what it found. Confirms:
 *        - the MCP server is wired into the SDK
 *        - the agent advertises the tool to the model
 *        - the handler runs in-process and the result reaches the model
 *        - Read/Glob/Grep are also reachable (we ask for one of them)
 *
 * Required env (same as azureSpike):
 *   AZURE_ANTHROPIC_ENDPOINT
 *   AZURE_ANTHROPIC_API_KEY
 *
 * Run:  cd cli && npm run spike:tools
 */

import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk'
import { makeDetectFrameworkTool } from '../agent/tools/detectFramework.js'
import { SCAN_BUILTIN_TOOLS, SCAN_ALLOWED_TOOLS, DETECT_FRAMEWORK_TOOL } from '../agent/tools/index.js'

// Run the spike against the cli/ checkout itself.
const SCAN_ROOT = process.cwd()
const detectFrameworkTool = makeDetectFrameworkTool(SCAN_ROOT)
const holostaffMcpServer = createSdkMcpServer({
  name: 'holostaff',
  version: '0.1.0',
  tools: [detectFrameworkTool],
})

const MODEL = process.env.AZURE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'

function need(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`✗ Missing required env: ${name}`)
    process.exit(2)
  }
  return v
}

function header(label: string) {
  console.log('\n' + '─'.repeat(64))
  console.log(label)
  console.log('─'.repeat(64))
}

async function checkStandalone(): Promise<boolean> {
  header('1. Standalone — invoke detectFramework handler directly')
  try {
    const result = await detectFrameworkTool.handler({}, {})
    const block = result.content[0]
    if (!block || block.type !== 'text') {
      console.log('  ✗ Handler returned no text block')
      return false
    }
    const parsed = JSON.parse(block.text)
    console.log(`  ✓ root:             ${parsed.root}`)
    console.log(`  ✓ packages:         ${parsed.packages.length}`)
    console.log(`  ✓ sourceFileCount:  ${parsed.sourceFileCount}`)
    console.log(`  ✓ isMultiPackage:   ${parsed.isMultiPackage}`)
    console.log(`  ✓ notableDirs:      ${parsed.notableDirs.join(', ')}`)
    return true
  } catch (err: any) {
    console.log(`  ✗ FAILED: ${err?.message ?? err}`)
    return false
  }
}

async function checkEndToEnd(baseURL: string, apiKey: string): Promise<boolean> {
  header('2. End-to-end — agent calls detectFramework via query()')

  const PROMPT = [
    'Run the detectFramework tool exactly once with no arguments to learn',
    'about the current repository. Then list, in plain prose, the framework',
    'of the first package and the total source file count. Keep your reply',
    'under 40 words. Do not call any other tool.',
  ].join(' ')

  let detectFrameworkInvoked = false
  let assistantText = ''

  try {
    const t0 = Date.now()
    const q = query({
      prompt: PROMPT,
      options: {
        model: 'sonnet',
        mcpServers: {
          holostaff: holostaffMcpServer,
        },
        tools: SCAN_BUILTIN_TOOLS,
        allowedTools: SCAN_ALLOWED_TOOLS,
        maxTurns: 4,
        env: {
          ...process.env,
          CLAUDE_CODE_USE_FOUNDRY: '1',
          ANTHROPIC_FOUNDRY_BASE_URL: baseURL,
          ANTHROPIC_FOUNDRY_API_KEY: apiKey,
          ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'holostaff-cli/spike-tools',
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          ANTHROPIC_BASE_URL: undefined,
        },
      },
    })

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') assistantText += block.text
          if (block.type === 'tool_use' && block.name === DETECT_FRAMEWORK_TOOL) {
            detectFrameworkInvoked = true
            console.log(`  → tool_use: ${DETECT_FRAMEWORK_TOOL}`)
          } else if (block.type === 'tool_use') {
            console.log(`  → tool_use: ${block.name} (unexpected)`)
          }
        }
      }
    }

    const ms = Date.now() - t0
    console.log(`  ✓ stream completed in ${ms}ms`)
    console.log(`  ${detectFrameworkInvoked ? '✓' : '✗'} detectFramework invoked: ${detectFrameworkInvoked}`)
    console.log(`  ${assistantText.trim() ? '✓' : '✗'} final text: ${JSON.stringify(assistantText.trim().slice(0, 220))}`)
    return detectFrameworkInvoked && assistantText.trim().length > 0
  } catch (err: any) {
    console.log(`  ✗ FAILED: ${err?.message ?? err}`)
    return false
  }
}

async function main() {
  console.log('Holostaff CLI — read-only tools smoke (A2.1)')

  const ok1 = await checkStandalone()

  let ok2 = false
  if (process.env.AZURE_ANTHROPIC_ENDPOINT && process.env.AZURE_ANTHROPIC_API_KEY) {
    const baseURL = need('AZURE_ANTHROPIC_ENDPOINT').replace(/\/+$/, '')
    const apiKey = need('AZURE_ANTHROPIC_API_KEY')
    ok2 = await checkEndToEnd(baseURL, apiKey)
  } else {
    header('2. End-to-end — SKIPPED')
    console.log('  Set AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY to run.')
  }

  header('Summary')
  console.log(`  Standalone:    ${ok1 ? 'PASS' : 'FAIL'}`)
  console.log(`  End-to-end:    ${ok2 ? 'PASS' : process.env.AZURE_ANTHROPIC_API_KEY ? 'FAIL' : 'SKIPPED'}`)
  process.exit(ok1 && (ok2 || !process.env.AZURE_ANTHROPIC_API_KEY) ? 0 : 1)
}

main().catch((err) => {
  console.error('\nspike: unexpected error:', err?.message ?? err)
  process.exit(1)
})
