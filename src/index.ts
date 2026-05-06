#!/usr/bin/env node

/**
 * Holostaff CLI entry point. v0.1: just enough scaffolding to detect
 * the repo and render the welcome banner. Auth + scan + instrument
 * + embed land in subsequent passes per PRD §12 (track A).
 */

import React from 'react'
import { render } from 'ink'
import { detectRepo } from './detect/repo.js'
import { App } from './ui/App.js'

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
  const cwd = process.cwd()
  const detection = detectRepo(cwd)
  const version = readVersion()

  // The interactive shell needs a TTY (Ink uses raw-mode input). If
  // we're piped, redirected, or running in CI, we should fail with a
  // helpful message instead of crashing on the first keystroke. The
  // hook for `--quiet --json` mode lives here too — once we ship CI
  // mode, this branch dispatches to the non-interactive path.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `holostaff: this is the interactive surface and needs a real terminal.\n`
      + `For CI / scripted use, run with --quiet --json (lands in milestone A7).\n`,
    )
    process.exit(2)
  }

  // Render the welcome + first-run menu. Subsequent passes will add
  // auth flow + conversational shell.
  const { waitUntilExit } = render(
    React.createElement(App, { detection, version }),
  )

  await waitUntilExit()
}

main().catch((err) => {
  console.error('\nholostaff: unexpected error:', err?.message ?? err)
  process.exit(1)
})
