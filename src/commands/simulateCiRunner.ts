/**
 * `holostaff simulate --ci` — run the workspace's canvas scenarios inside
 * a CI job (user-simulation PRD P4, D8: in-CI is the default).
 *
 * The job's ingredients, and where each comes from:
 *   recipe     ./.holostaff/environment.json (merged via the recipe PR, D12)
 *   scenarios  the source's live artifact (GET /api/cli/sim/manifest)
 *   personas   the workspace Studio (same manifest)
 *   account    CI secrets: HOLOSTAFF_SIM_ACCOUNT_EMAIL / _PASSWORD
 *   model      Holostaff's metered proxy (or the job's own OPENAI_API_KEY)
 *   results    POST /api/cli/sim/results → the workspace Results surface
 *
 * The engine itself ships with this package (src/engine, synced from the
 * platform repo). Recordings stay in the job's artifact store in v1.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import type { SimulateArgs } from './argv.js'

const HERE = dirname(fileURLToPath(import.meta.url))

interface Recipe {
  target?: string
  serve?: {
    kind?: string
    workDir?: string
    files?: string[]
    command?: string
    buildCommand?: string
    depsCompose?: string
    healthUrl?: string
    healthTimeoutMs?: number
    env?: Record<string, string>
  }
  initLocalStorage?: Record<string, string>
}

interface ManifestScenario {
  id: string
  workflowName: string
  personaIds: string[]
  spec: Record<string, unknown> & { guards?: { maxSteps?: number; wallMin?: number } }
}

interface Manifest {
  personas: Array<Record<string, unknown> & { id: string }>
  scenarios: ManifestScenario[]
}

const log = (m: string) => process.stderr.write(`holostaff sim: ${m}\n`)

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000) })
    return res.status < 500
  } catch { return false }
}

async function serveUp(recipe: Recipe, cwd: string): Promise<void> {
  const serve = recipe.serve ?? {}
  const url = serve.healthUrl
  if (!url) throw new Error('the recipe has no serve.healthUrl')
  if (await healthy(url)) { log(`app already answering at ${url}`); return }

  const env = { ...process.env, ...(serve.env ?? {}) }
  if (serve.kind === 'compose' && serve.files?.length) {
    const fileArgs = serve.files.flatMap(f => ['-f', f])
    log(`docker compose up (${serve.files.join(', ')})`)
    const r = spawnSync('docker', ['compose', ...fileArgs, 'up', '-d'], {
      cwd: join(cwd, serve.workDir ?? '.'), env, stdio: 'inherit',
    })
    if (r.status !== 0) log('compose up exited nonzero; waiting on health anyway (slow cold boots recover)')
  } else if (serve.kind === 'external' && serve.command) {
    const wd = join(cwd, serve.workDir ?? '.')
    if (serve.depsCompose) {
      spawnSync('docker', ['compose', '-f', serve.depsCompose, 'up', '-d'], { cwd: wd, env, stdio: 'inherit' })
    }
    if (serve.buildCommand) {
      log(`build: ${serve.buildCommand}`)
      const b = spawnSync('sh', ['-c', serve.buildCommand], { cwd: wd, env, stdio: 'inherit' })
      if (b.status !== 0) throw new Error('the recipe buildCommand failed')
    }
    log(`start: ${serve.command}`)
    const child = spawn('sh', ['-c', serve.command], { cwd: wd, env, detached: true, stdio: 'ignore' })
    child.unref()
  } else {
    throw new Error(`serve.kind "${serve.kind}" is not runnable in CI yet`)
  }

  const timeoutMs = serve.healthTimeoutMs ?? 600_000
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await healthy(url)) { log(`app is up at ${url}`); return }
    await new Promise(r => setTimeout(r, 5_000))
  }
  throw new Error(`the app never answered at ${url} within ${Math.round(timeoutMs / 1000)}s`)
}

export async function runSimulateCiMode(opts: SimulateArgs): Promise<number> {
  const apiKey = process.env.HOLOSTAFF_API_KEY ?? ''
  const apiBase = (process.env.HOLOSTAFF_API_BASE_URL
    ?? 'https://holostaff-vision-1008066443043.us-central1.run.app').replace(/\/$/, '')
  if (!apiKey) { log('HOLOSTAFF_API_KEY is required in CI mode'); return 2 }
  const sourceId = opts.sourceId ?? process.env.HOLOSTAFF_SOURCE_ID ?? ''
  if (!sourceId) { log('pass --source <id> or set HOLOSTAFF_SOURCE_ID'); return 2 }

  const recipePath = join(process.cwd(), '.holostaff', 'environment.json')
  if (!existsSync(recipePath)) {
    log('no .holostaff/environment.json in this repo. Merge the environment recipe PR first.')
    return 2
  }
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as Recipe

  log(`fetching scenarios + personas for ${sourceId}`)
  const mres = await fetch(`${apiBase}/api/cli/sim/manifest?sourceId=${encodeURIComponent(sourceId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!mres.ok) { log(`manifest fetch failed: HTTP ${mres.status} ${(await mres.text()).slice(0, 200)}`); return 2 }
  const manifest = await mres.json() as Manifest
  let scenarios = manifest.scenarios
  if (opts.scenarioId) scenarios = scenarios.filter(s => s.id === opts.scenarioId)
  if (!scenarios.length) { log('no scenarios to run. Author one on the journey map canvas.'); return 2 }
  log(`${scenarios.length} scenario(s), ${manifest.personas.length} persona(s) in the workspace`)

  await serveUp(recipe, process.cwd())
  if (opts.preflightOnly) { log('preflight-only: done'); return 0 }

  // Materialize the engine's working dir: persona + scenario sheets.
  const simDir = join(tmpdir(), `holostaff-sim-${Date.now().toString(36)}`)
  mkdirSync(join(simDir, 'personas'), { recursive: true })
  mkdirSync(join(simDir, 'scenarios'), { recursive: true })
  const outDir = join(process.cwd(), '.holostaff', 'sim-runs')
  mkdirSync(outDir, { recursive: true })
  for (const p of manifest.personas) {
    writeFileSync(join(simDir, 'personas', `${p.id}.json`), JSON.stringify(p, null, 2))
  }

  const account = process.env.HOLOSTAFF_SIM_ACCOUNT_EMAIL && process.env.HOLOSTAFF_SIM_ACCOUNT_PASSWORD
    ? { email: process.env.HOLOSTAFF_SIM_ACCOUNT_EMAIL, password: process.env.HOLOSTAFF_SIM_ACCOUNT_PASSWORD }
    : undefined
  const baseUrl = new URL(recipe.serve!.healthUrl!).origin

  const engine = join(HERE, '..', 'engine', 'run.js')
  if (!existsSync(engine)) { log(`bundled engine missing at ${engine}`); return 2 }

  // Model access: the job's own key wins; otherwise Holostaff's metered proxy.
  const modelEnv = process.env.OPENAI_API_KEY
    ? {}
    : { SIM_MODEL_BASE_URL: `${apiBase}/api/cli/sim`, SIM_MODEL_KEY: apiKey }

  let failures = 0
  let ran = 0
  for (const scenario of scenarios) {
    const personaIds = scenario.personaIds.length ? scenario.personaIds : manifest.personas.slice(0, 1).map(p => p.id)
    const spec = {
      id: scenario.id,
      target: recipe.target ?? 'app',
      baseUrl,
      ...(recipe.initLocalStorage ? { initLocalStorage: recipe.initLocalStorage } : {}),
      ...(account ? { credentials: account } : {}),
      startPath: (scenario.spec.startPath as string) ?? '/',
      context: (scenario.spec.context as string) ?? '',
      goal: typeof scenario.spec.goal === 'object' && scenario.spec.goal
        ? String((scenario.spec.goal as { text?: string }).text ?? '')
        : String(scenario.spec.goal ?? ''),
      maxSteps: scenario.spec.guards?.maxSteps ?? 45,
      wallMin: scenario.spec.guards?.wallMin ?? 20,
    }
    writeFileSync(join(simDir, 'scenarios', `${scenario.id}.json`), JSON.stringify(spec, null, 2))

    for (const personaId of personaIds) {
      if (!manifest.personas.some(p => p.id === personaId)) continue
      ran++
      log(`run: ${scenario.spec.name ?? scenario.id} as ${personaId}`)
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [engine, '--persona', personaId, '--scenario', scenario.id], {
          env: { ...process.env, SIM_DIR: simDir, SIM_OUT: outDir, ...modelEnv },
          stdio: 'inherit',
        })
        child.on('close', c => resolve(c ?? 1))
        child.on('error', () => resolve(1))
      })
      if (code !== 0) { failures++; continue }

      // newest run dir carries the result
      const latest = readdirSync(outDir).map(d => join(outDir, d))
        .filter(d => existsSync(join(d, 'run.json')))
        .sort((a, b) => (a < b ? 1 : -1))[0]
      if (!latest) { failures++; continue }
      const runJson = JSON.parse(readFileSync(join(latest, 'run.json'), 'utf8')) as { endState?: string }
      const cogs = existsSync(join(latest, 'cogs.json'))
        ? JSON.parse(readFileSync(join(latest, 'cogs.json'), 'utf8'))
        : null
      if (runJson.endState !== 'done') failures++
      const up = await fetch(`${apiBase}/api/cli/sim/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioId: scenario.id,
          personaId,
          name: scenario.spec.name ?? scenario.id,
          runJson,
          cogs,
        }),
      })
      log(up.ok ? `result uploaded (${runJson.endState})` : `result upload failed: HTTP ${up.status}`)
    }
  }

  log(`${ran} run(s), ${failures} did not reach the goal`)
  return failures > 0 ? 1 : 0
}
