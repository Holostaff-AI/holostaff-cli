/**
 * A6 — /embed smoke against an isolated fixture.
 *
 * What it does:
 *   1. Builds /tmp/holostaff-embed-test as a fresh git repo with a
 *      Vite-style index.html in src/ — the agent's natural target.
 *   2. Runs runEmbed against it. Agent should detect Vue/Vite, find
 *      index.html, and propose an edit injecting the widget script
 *      tag with REPLACE_WITH_COPILOT_ID.
 *   3. Applies the plan via the shared applyPlan.
 *   4. Verifies: branch created, commit exists, index.html contains
 *      the script tag with the placeholder + the unpkg widget URL.
 *
 * Required env: AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY.
 *
 * Run:  cd cli && npm run spike:embed
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { runEmbed } from '../agent/embed/runEmbed.js'
import { applyPlan } from '../instrument/applyPlan.js'

const exec = promisify(execFile)

const FIXTURE = '/tmp/holostaff-embed-test'
const FAKE_WORKSPACE = 'workspace_smoke_a6'
const FAKE_SOURCE = 'ks_smoke_a6'

async function setupFixture(): Promise<void> {
  console.log(`· building fixture at ${FIXTURE}`)
  if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true })
  mkdirSync(FIXTURE, { recursive: true })
  mkdirSync(join(FIXTURE, 'src'))

  writeFileSync(
    join(FIXTURE, 'package.json'),
    JSON.stringify(
      {
        name: 'embed-smoke-fixture',
        version: '0.0.1',
        type: 'module',
        dependencies: { vue: '^3.4.0' },
        devDependencies: { vite: '^5.0.0' },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(FIXTURE, 'package-lock.json'), '{}\n')
  writeFileSync(
    join(FIXTURE, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Embed Smoke Fixture</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  )
  writeFileSync(
    join(FIXTURE, 'src/main.ts'),
    `import { createApp } from 'vue'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n`,
  )
  writeFileSync(join(FIXTURE, 'src/App.vue'), `<template>\n  <div>Hello</div>\n</template>\n`)

  await exec('git', ['init', '-b', 'main'], { cwd: FIXTURE })
  await exec('git', ['add', '.'], { cwd: FIXTURE })
  await exec('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@local', 'commit', '-m', 'initial'], { cwd: FIXTURE })
  console.log(`✓ fixture ready`)
}

async function main(): Promise<void> {
  console.log('Holostaff CLI — /embed smoke (A6)')
  console.log()

  if (!process.env.AZURE_ANTHROPIC_ENDPOINT || !process.env.AZURE_ANTHROPIC_API_KEY) {
    console.error('✗ Missing AZURE_ANTHROPIC_ENDPOINT or AZURE_ANTHROPIC_API_KEY')
    process.exit(2)
  }

  await setupFixture()

  console.log()
  console.log('· running agent…')
  const t0 = Date.now()
  let toolCalls = 0
  const result = await runEmbed({
    cwd: FIXTURE,
    onEvent: (ev) => {
      if (ev.type === 'tool_use') {
        toolCalls++
        if (ev.tool.startsWith('mcp__')) console.log(`  ↳ ${ev.tool.split('__').pop()}`)
      }
    },
  })
  console.log(`· agent done in ${Date.now() - t0}ms (${toolCalls} tool calls)`)

  if (!result.ok) {
    console.error(`✗ agent failed: ${result.reason} — ${result.error}`)
    process.exit(1)
  }
  const plan = result.plan
  console.log()
  console.log(`✓ plan: ${plan.summary}`)
  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i]!
    if (op.kind === 'install')
      console.log(`  ${i + 1}. install: ${op.packageManager} ${op.packages.join(' ')}`)
    else if (op.kind === 'edit')
      console.log(`  ${i + 1}. edit ${op.file}: ${op.reason}`)
    else
      console.log(`  ${i + 1}. create ${op.file}: ${op.reason}`)
  }
  if (plan.coverageGaps.length) {
    console.log('  coverage gaps:')
    for (const g of plan.coverageGaps) console.log(`    ▸ ${g}`)
  }

  console.log()
  console.log('· applying plan…')
  const apply = await applyPlan({
    cwd: FIXTURE,
    plan,
    workspaceId: FAKE_WORKSPACE,
    sourceId: FAKE_SOURCE,
    onEvent: (ev) => {
      if (ev.type === 'committed') console.log(`  ✓ committed ${ev.sha.slice(0, 7)} on ${ev.branch}`)
      if (ev.type === 'op_failed') console.log(`  ✗ op ${ev.index + 1}: ${ev.error}`)
      if (ev.type === 'failed') console.log(`  ✗ ${ev.error}`)
    },
  })
  if (!apply.ok) {
    console.error(`✗ apply failed at ${apply.step}: ${apply.error}`)
    process.exit(1)
  }

  console.log()
  console.log('· verifying…')
  const indexHtml = readFileSync(join(FIXTURE, 'index.html'), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['index.html contains hs-widget src', /hs-widget/.test(indexHtml)],
    ['has data-staff-id attribute', /data-staff-id=/.test(indexHtml)],
    ['placeholder REPLACE_WITH_COPILOT_ID present', indexHtml.includes('REPLACE_WITH_COPILOT_ID')],
    [`branch ${apply.branch} exists`, await branchExists(apply.branch)],
  ]
  let allOk = true
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) allOk = false
  }

  console.log()
  if (!allOk) {
    console.log('✗ some checks failed; index.html contents:')
    console.log(indexHtml.split('\n').map((l) => `    ${l}`).join('\n'))
    process.exit(1)
  }
  console.log('✓ /embed smoke passed')
  console.log(`  fixture left at ${FIXTURE} on branch ${apply.branch}`)
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', branch], { cwd: FIXTURE })
    return true
  } catch {
    return false
  }
}

await main()
