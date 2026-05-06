#!/usr/bin/env node

/**
 * Holostaff CLI entry point. v0.1: just enough scaffolding to detect
 * the repo and render the welcome banner. Auth + scan + instrument
 * + embed land in subsequent passes per PRD §12 (track A).
 */

import React from 'react'
import { render } from 'ink'
import { detectRepo } from './detect/repo.js'
import { Welcome } from './ui/Welcome.js'

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

  // Render the welcome banner. Subsequent passes will add the
  // first-run menu, auth flow, and conversational shell.
  const { waitUntilExit } = render(
    React.createElement(Welcome, { detection, version }),
  )

  await waitUntilExit()
}

main().catch((err) => {
  console.error('\nholostaff: unexpected error:', err?.message ?? err)
  process.exit(1)
})
