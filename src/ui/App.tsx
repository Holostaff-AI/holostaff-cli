/**
 * Top-level Ink shell for the Holostaff CLI.
 *
 * State machine after A3:
 *
 *   booting → auth?
 *     ├── yes → shell (chat with slash commands)
 *     └── no  → login → shell
 *
 *   shell --[/scan]--> scan flow --[onExit]--> shell (with result in scrollback)
 *   shell --[/login]-> auth → shell
 *   shell --[/quit]--> exit
 *
 * The shell owns scrollback; transient flows like /scan replace the
 * shell view while running, then return control with a typed result
 * the shell appends as a system message.
 */

import React, { useState } from 'react'
import { Box } from 'ink'
import { useApp } from 'ink'
import type { RepoDetection } from '../detect/repo.js'
import { Welcome } from './Welcome.js'
import { Login } from './Login.js'
import { Scan, type ScanExitResult } from './scan/Scan.js'
import { Shell, type ShellAction } from './chat/Shell.js'
import { newId, type ShellMessage } from './chat/types.js'
import { resolveAuth, type ResolvedAuth } from '../auth/credentials.js'

type Phase = 'auth' | 'shell' | 'scan'

export function App({
  detection,
  version,
  forceLogin = false,
  exitAfterLogin = false,
}: {
  detection: RepoDetection
  version: string
  /** Treat current creds as absent — used by `holostaff login` to re-auth. */
  forceLogin?: boolean
  /** Exit the process as soon as login completes — used by `holostaff login`. */
  exitAfterLogin?: boolean
}) {
  const { exit } = useApp()
  const [auth, setAuth] = useState<ResolvedAuth>(() => resolveAuth())
  const [hasReauthed, setHasReauthed] = useState(false)
  const [phase, setPhase] = useState<Phase>('shell')
  // Shell scrollback persists across scan/auth round-trips so the
  // user sees the full session in scrollback without context loss.
  const [shellMessages, setShellMessages] = useState<ShellMessage[] | undefined>(undefined)

  // Auth gate. forceLogin overrides until the user re-auths once.
  const needsAuth =
    (forceLogin && !hasReauthed) || auth.source === 'none' || auth.expired
  const effectivePhase: Phase = needsAuth ? 'auth' : phase

  function handleShellAction(action: ShellAction, history: ShellMessage[]) {
    setShellMessages(history)
    if (action === 'exit') return exit()
    if (action === 'open_scan') return setPhase('scan')
    if (action === 'reauth') {
      setHasReauthed(false)
      setAuth({ ...auth, source: 'none' as const, expired: true })
    }
  }

  function handleScanExit(result?: ScanExitResult) {
    const summary = scanResultMessage(result)
    setShellMessages((prev) => [...(prev ?? []), ...summary])
    setPhase('shell')
  }

  function handleLoginDone() {
    setHasReauthed(true)
    setAuth(resolveAuth())
    if (exitAfterLogin) {
      setTimeout(() => exit(), 600)
    }
  }

  return (
    <Box flexDirection="column">
      <Welcome detection={detection} version={version} />
      {effectivePhase === 'auth' && (
        <Login baseUrl={auth.baseUrl} onDone={handleLoginDone} />
      )}
      {effectivePhase === 'shell' && (
        <Shell initialMessages={shellMessages} onAction={handleShellAction} />
      )}
      {effectivePhase === 'scan' && (
        <Scan cwd={detection.root} onExit={handleScanExit} />
      )}
    </Box>
  )
}

function scanResultMessage(result: ScanExitResult | undefined): ShellMessage[] {
  if (!result) return []
  switch (result.kind) {
    case 'uploaded':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'success',
          text: `Uploaded ${result.sourceName} version ${result.version}.\nView at ${result.viewUrl}`,
        },
      ]
    case 'saved_local':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'info',
          text: `Saved artifact locally to ${result.path}. No upload sent.`,
        },
      ]
    case 'cancelled':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'info',
          text: 'Scan cancelled. Nothing was uploaded.',
        },
      ]
    case 'failed':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'error',
          text: `Scan failed: ${result.error}`,
        },
      ]
  }
}
