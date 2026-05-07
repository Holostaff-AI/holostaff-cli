/**
 * A2.4 — interactive scan + trust report spike.
 *
 * Renders the production <Scan/> view standalone. Use this when
 * iterating on the trust report layout without going through the
 * full holostaff CLI flow (auth, menu, etc.).
 *
 * Required env: AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY.
 * Optional: SCAN_TARGET_DIR (default: cwd).
 *
 * Run:  cd cli && npm run spike:scan-ink
 */

import React from 'react'
import { render } from 'ink'
import { Scan } from '../ui/scan/Scan.js'

const cwd = process.env.SCAN_TARGET_DIR ?? process.cwd()

const { waitUntilExit, unmount } = render(
  React.createElement(Scan, {
    cwd,
    onExit: () => unmount(),
  }),
)

await waitUntilExit()
