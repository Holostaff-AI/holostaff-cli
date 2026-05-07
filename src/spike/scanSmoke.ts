/**
 * A2.2 — agent loop + system prompt smoke spike.
 *
 * Runs runScan against a repo and prints:
 *   - the live event stream (tool calls, brief reasoning lines)
 *   - the final structured findings
 *   - a small set of sanity assertions
 *
 * Required env:
 *   AZURE_ANTHROPIC_ENDPOINT
 *   AZURE_ANTHROPIC_API_KEY
 *
 * Optional:
 *   SCAN_TARGET_DIR — repo root to scan. Defaults to the current
 *     cwd. Pick a small real app to keep iteration tight, e.g.
 *     /home/galem/ai-canvas.
 *
 * Run:  cd cli && npm run spike:scan
 */

import { runScan, buildAgentEnv, type ScanEvent } from '../agent/runScan.js'

function header(label: string) {
  console.log('\n' + '─'.repeat(72))
  console.log(label)
  console.log('─'.repeat(72))
}

function summarize(input: unknown, max = 100): string {
  try {
    const json = JSON.stringify(input)
    return json.length > max ? json.slice(0, max - 1) + '…' : json
  } catch {
    return String(input).slice(0, max)
  }
}

function onEvent(ev: ScanEvent) {
  switch (ev.type) {
    case 'started':
      console.log(`▶ scan started — cwd: ${ev.cwd}`)
      break
    case 'thinking':
      // Model reasoning — keep it short to not flood the log.
      console.log(`  💭 ${ev.text.slice(0, 200)}${ev.text.length > 200 ? '…' : ''}`)
      break
    case 'tool_use':
      console.log(`  🛠  ${ev.tool}(${summarize(ev.input)})`)
      break
    case 'tool_result':
      console.log(`  ↳  ${ev.isError ? '✗' : '✓'} ${ev.preview}`)
      break
    case 'submitted':
      console.log(`  ✓ submitFindings received`)
      break
    case 'completed':
      // Printed in main; this just acknowledges.
      break
    case 'failed':
      console.log(`  ✗ failed: ${ev.error}`)
      break
  }
}

async function main() {
  const env = buildAgentEnv()
  if (!env) {
    console.error('✗ Missing AZURE_ANTHROPIC_ENDPOINT and/or AZURE_ANTHROPIC_API_KEY')
    process.exit(2)
  }

  const cwd = process.env.SCAN_TARGET_DIR ?? process.cwd()
  console.log('Holostaff CLI — scan smoke (A2.2)')
  console.log(`Target: ${cwd}`)

  header('Stream')
  const result = await runScan({
    cwd,
    onEvent,
    env,
    maxTurns: 30,
  })

  header('Result')
  if (!result.ok) {
    console.log(`✗ scan failed (${result.reason}): ${result.error}`)
    console.log(`  duration: ${result.durationMs}ms`)
    process.exit(1)
  }

  console.log(`✓ scan ok — ${result.durationMs}ms, tokens in=${result.tokens.input} out=${result.tokens.output}`)
  console.log(`  sessionId: ${result.sessionId}`)
  console.log()
  console.log(`  productName:        ${result.findings.productName}`)
  console.log(`  oneLineDescription: ${result.findings.oneLineDescription}`)
  console.log(`  primaryFramework:   ${result.findings.primaryFramework}`)
  console.log(`  language:           ${result.findings.language}`)
  console.log(`  routes:             ${result.findings.routes.length}`)
  console.log(`  components:         ${result.findings.components.length}`)
  console.log(`  copy:               ${result.findings.copy.length}`)
  console.log(`  workflows:          ${result.findings.workflows.length}`)
  console.log(`  coverageGaps:       ${result.findings.coverageGaps.length}`)
  if (result.findings.routes.length > 0) {
    console.log()
    console.log('  Sample routes:')
    for (const r of result.findings.routes.slice(0, 5)) {
      console.log(`    - ${r.path}  (${r.description})`)
    }
  }
  if (result.findings.coverageGaps.length > 0) {
    console.log()
    console.log('  Coverage gaps:')
    for (const g of result.findings.coverageGaps.slice(0, 5)) {
      console.log(`    - ${g}`)
    }
  }

  // Light sanity checks — productName must be non-empty, framework too.
  const issues: string[] = []
  if (!result.findings.productName.trim()) issues.push('productName empty')
  if (!result.findings.oneLineDescription.trim()) issues.push('oneLineDescription empty')
  if (!result.findings.primaryFramework.trim()) issues.push('primaryFramework empty')
  if (issues.length) {
    console.log()
    console.log(`  ⚠ sanity issues: ${issues.join(', ')}`)
    process.exit(1)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('\nspike: unexpected error:', err?.message ?? err)
  process.exit(1)
})
