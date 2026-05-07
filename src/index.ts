#!/usr/bin/env node

/**
 * Holostaff CLI entry point. Dispatches on argv:
 *
 *   holostaff                    → interactive (welcome → auth → menu)
 *   holostaff login              → interactive, forces re-auth, then exit
 *   holostaff logout|whoami|...  → plain-text command, no Ink
 *   holostaff scan [...]         → headless / CI scan (no Ink, JSON output)
 *   holostaff --help|--version   → plain-text, no Ink
 *
 * The TTY guard only runs for interactive paths. Plain-text + CI
 * commands work fine when piped.
 */

import React from 'react'
import { render } from 'ink'
import { detectRepo } from './detect/repo.js'
import { App } from './ui/App.js'
import { parseArgs } from './commands/argv.js'
import {
  runHelp,
  runLogout,
  runUnknown,
  runVersion,
  runWhoami,
  runWorkspace,
} from './commands/text.js'
import { runScanCi } from './commands/scanCi.js'

// Read version from our own package.json at runtime — keeps a single
// source of truth and avoids bake-in drift.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = readVersion()

  // ─── Plain-text commands ─────────────────────────────────────
  // No TTY needed; these just touch local state + print.
  switch (args.kind) {
    case 'help':      process.exit(runHelp())
    case 'version':   process.exit(runVersion(version))
    case 'whoami':    process.exit(runWhoami())
    case 'logout':    process.exit(runLogout())
    case 'workspace': process.exit(runWorkspace())
    case 'unknown':   process.exit(runUnknown(args.arg))
    case 'bad_args':
      process.stderr.write(`holostaff: ${args.reason}\n`)
      process.exit(2)
    case 'scan':
      // Headless CI mode — no TTY guard, no Ink.
      process.exit(await runScanCi(args.opts, process.cwd()))
  }

  // ─── Interactive paths (login + default) ─────────────────────
  // Both need a real terminal because they render Ink and use raw-mode
  // input. We bail with a friendly message if invoked without one.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `holostaff: this is the interactive surface and needs a real terminal.\n`
      + `For CI / scripted use, run \`holostaff scan --quiet --json\`.\n`,
    )
    process.exit(2)
  }

  const cwd = process.cwd()
  const detection = detectRepo(cwd)

  const { waitUntilExit } = render(
    React.createElement(App, {
      detection,
      version,
      forceLogin: args.kind === 'login',
      exitAfterLogin: args.kind === 'login',
    }),
  )

  await waitUntilExit()
}

main().catch((err) => {
  console.error('\nholostaff: unexpected error:', err?.message ?? err)
  process.exit(1)
})
