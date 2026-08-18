/**
 * `holostaff simulate <suite>` — run a synthetic-user suite and print
 * the report (user-simulation PRD §4.7).
 *
 * The simulation engine is not bundled with the CLI yet: until the
 * in-CI runner ships (PRD P4), this command dispatches to a local
 * engine checkout named by HOLOSTAFF_SIM_ENGINE (the holostaff-agent
 * server directory). Exit codes pass through: 0 ok, 1 threshold
 * breach, 2 preflight/config failure.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulateArgs } from './argv.js'
import { runSimulateCiMode } from './simulateCiRunner.js'

export function runSimulateCi(opts: SimulateArgs): Promise<number> {
  if (opts.ci) {
    return runSimulateCiMode(opts).catch((err: Error) => {
      process.stderr.write(`holostaff sim: ${err.message}\n`)
      return 2
    })
  }
  const engine = process.env.HOLOSTAFF_SIM_ENGINE ?? ''
  if (!engine || !existsSync(join(engine, 'scripts/sim/suite.ts'))) {
    process.stderr.write(
      'holostaff: the simulation engine is not available on this machine.\n'
      + 'Set HOLOSTAFF_SIM_ENGINE to your engine checkout (the directory\n'
      + 'containing scripts/sim/). The hosted runner ships with the CI\n'
      + 'integration — see holostaff.ai/docs.\n',
    )
    return Promise.resolve(2)
  }
  const args = ['tsx', 'scripts/sim/suite.ts', '--suite', opts.suite]
  if (opts.baseline) args.push('--baseline', opts.baseline)
  if (opts.label) args.push('--label', opts.label)
  if (opts.preflightOnly) args.push('--preflight-only')
  return new Promise((resolve) => {
    const p = spawn('npx', args, { cwd: engine, stdio: 'inherit' })
    p.on('close', code => resolve(code ?? 1))
    p.on('error', (err) => {
      process.stderr.write(`holostaff: could not start the engine: ${err.message}\n`)
      resolve(2)
    })
  })
}
