/**
 * A5 — /instrument smoke against an isolated fixture.
 *
 * What it does:
 *   1. Builds /tmp/holostaff-instrument-test as a fresh git repo with
 *      a Vue 3-shaped src/main.ts and a package-lock.json (so the
 *      detector picks npm).
 *   2. Runs runInstrument against it. The agent should detect Vue 3,
 *      read main.ts, and propose an install + edit plan.
 *   3. Applies the plan with synthetic workspaceId / sourceId.
 *   4. Verifies: branch was created, main.ts contains the import +
 *      Holostaff.init() call with the substituted ids, commit exists
 *      on the branch.
 *
 * Required env: AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY.
 *
 * Run:  cd cli && npm run spike:instrument
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { runInstrument } from '../agent/instrument/runInstrument.js'
import { applyPlan } from '../instrument/applyPlan.js'

const exec = promisify(execFile)

const FIXTURE = '/tmp/holostaff-instrument-test'
const FAKE_WORKSPACE = 'workspace_smoke_a5'
const FAKE_SOURCE = 'ks_smoke_a5'

async function setupFixture(): Promise<void> {
  console.log(`· building fixture at ${FIXTURE}`)
  if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true })
  mkdirSync(FIXTURE, { recursive: true })
  mkdirSync(join(FIXTURE, 'src'))

  writeFileSync(
    join(FIXTURE, 'package.json'),
    JSON.stringify(
      {
        name: 'instrument-smoke-fixture',
        version: '0.0.1',
        type: 'module',
        dependencies: { vue: '^3.4.0' },
        devDependencies: { typescript: '^5.0.0', vite: '^5.0.0' },
      },
      null,
      2,
    ),
  )
  // Empty lockfile is enough — we just want detectFramework to find npm.
  writeFileSync(join(FIXTURE, 'package-lock.json'), '{}\n')
  writeFileSync(
    join(FIXTURE, 'src/main.ts'),
    `import { createApp } from 'vue'\nimport App from './App.vue'\nimport './style.css'\n\ncreateApp(App).mount('#app')\n`,
  )
  writeFileSync(
    join(FIXTURE, 'src/App.vue'),
    `<template>\n  <div>Hello fixture</div>\n</template>\n`,
  )

  await exec('git', ['init', '-b', 'main'], { cwd: FIXTURE })
  await exec('git', ['add', '.'], { cwd: FIXTURE })
  await exec('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@local', 'commit', '-m', 'initial'], { cwd: FIXTURE })
  console.log(`✓ fixture ready`)
}

async function main(): Promise<void> {
  console.log('Holostaff CLI — /instrument smoke (A5)')
  console.log()

  if (!process.env.AZURE_ANTHROPIC_ENDPOINT || !process.env.AZURE_ANTHROPIC_API_KEY) {
    console.error('✗ Missing AZURE_ANTHROPIC_ENDPOINT or AZURE_ANTHROPIC_API_KEY')
    process.exit(2)
  }

  await setupFixture()

  console.log()
  console.log('· running agent…')
  const t0 = Date.now()
  let detected = ''
  let toolCalls = 0
  const result = await runInstrument({
    cwd: FIXTURE,
    onEvent: (ev) => {
      if (ev.type === 'tool_use') {
        toolCalls++
        if (ev.tool === 'mcp__holostaff__detectFramework') detected = 'detectFramework'
        if (ev.tool.startsWith('mcp__')) console.log(`  ↳ ${ev.tool.split('__').pop()}`)
      }
    },
  })
  console.log(`· agent done in ${Date.now() - t0}ms (${toolCalls} tool calls; first was ${detected})`)

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
  const main = readFileSync(join(FIXTURE, 'src/main.ts'), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['main.ts mentions @holostaff/sdk', /@holostaff\/sdk/.test(main)],
    ['main.ts has Holostaff.init', /Holostaff\.init/.test(main)],
    ['workspaceId substituted', main.includes(FAKE_WORKSPACE)],
    ['sourceId substituted', main.includes(FAKE_SOURCE)],
    [`branch ${apply.branch} exists`, await branchExists(apply.branch)],
  ]

  let allOk = true
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
    if (!ok) allOk = false
  }

  console.log()
  if (!allOk) {
    console.log('✗ some checks failed; main.ts contents:')
    console.log(main.split('\n').map((l) => `    ${l}`).join('\n'))
    process.exit(1)
  }
  console.log('✓ /instrument smoke passed')
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
