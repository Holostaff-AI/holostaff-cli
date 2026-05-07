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
import { Refine, type RefineExitResult } from './refine/Refine.js'
import { Instrument, type InstrumentExitResult } from './instrument/Instrument.js'
import { Embed, type EmbedExitResult } from './embed/Embed.js'
import { Shell, type ShellAction } from './chat/Shell.js'
import { newId, type ShellMessage } from './chat/types.js'
import { resolveAuth, type ResolvedAuth } from '../auth/credentials.js'

type Phase = 'auth' | 'shell' | 'scan' | 'refine' | 'instrument' | 'embed'

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
  // Mode the next /scan run should use. Set by handleShellAction when
  // it parses '--add-repo' from the slash args.
  const [scanMergeMode, setScanMergeMode] = useState<'replace' | 'append'>('replace')

  // Auth gate. forceLogin overrides until the user re-auths once.
  const needsAuth =
    (forceLogin && !hasReauthed) || auth.source === 'none' || auth.expired
  const effectivePhase: Phase = needsAuth ? 'auth' : phase

  function handleShellAction(action: ShellAction, args: string, history: ShellMessage[]) {
    setShellMessages(history)
    if (action === 'exit') return exit()
    if (action === 'open_scan') {
      // /scan args today: '--add-repo' switches to merge mode.
      const wantsAppend = /(?:^|\s)--add-repo(?:\s|$)/.test(args)
      setScanMergeMode(wantsAppend ? 'append' : 'replace')
      return setPhase('scan')
    }
    if (action === 'open_refine') return setPhase('refine')
    if (action === 'open_instrument') return setPhase('instrument')
    if (action === 'open_embed') return setPhase('embed')
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

  function handleRefineExit(result: RefineExitResult) {
    const summary = refineResultMessage(result)
    setShellMessages((prev) => [...(prev ?? []), ...summary])
    setPhase('shell')
  }

  function handleInstrumentExit(result: InstrumentExitResult) {
    const summary = instrumentResultMessage(result)
    setShellMessages((prev) => [...(prev ?? []), ...summary])
    setPhase('shell')
  }

  function handleEmbedExit(result: EmbedExitResult) {
    const summary = embedResultMessage(result)
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
        <Scan cwd={detection.root} mergeMode={scanMergeMode} onExit={handleScanExit} />
      )}
      {effectivePhase === 'refine' && (
        <Refine cwd={detection.root} onExit={handleRefineExit} />
      )}
      {effectivePhase === 'instrument' && (
        <Instrument cwd={detection.root} onExit={handleInstrumentExit} />
      )}
      {effectivePhase === 'embed' && (
        <Embed cwd={detection.root} onExit={handleEmbedExit} />
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

function refineResultMessage(result: RefineExitResult): ShellMessage[] {
  switch (result.kind) {
    case 'saved':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'success',
          text: `Refinements saved to ${result.sourceName}.\nView at ${result.viewUrl}`,
        },
      ]
    case 'cancelled':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'info',
          text: 'Refine cancelled. Nothing was saved.',
        },
      ]
    case 'no_binding':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'warn',
          text: 'No knowledge source bound for this repo yet. Type /scan to create one first.',
        },
      ]
    case 'failed':
      return [
        {
          id: newId(),
          kind: 'system',
          tone: 'error',
          text: `Refine failed: ${result.error}`,
        },
      ]
  }
}

function instrumentResultMessage(result: InstrumentExitResult): ShellMessage[] {
  switch (result.kind) {
    case 'committed': {
      const lines = [
        `Instrumentation committed on branch ${result.branch} (${result.sha.slice(0, 7)}).`,
        `Files changed: ${result.filesChanged.length}.`,
      ]
      if (result.packagesToInstall.length && result.packageManager) {
        lines.push(
          `Run ${result.packageManager} ${result.packageManager === 'yarn' ? 'add' : 'install'} ${result.packagesToInstall.join(' ')} on the branch.`,
        )
      }
      lines.push(`Push when ready: git push -u origin ${result.branch}.`)
      return [{ id: newId(), kind: 'system', tone: 'success', text: lines.join('\n') }]
    }
    case 'cancelled':
      return [{ id: newId(), kind: 'system', tone: 'info', text: '/instrument cancelled. Nothing was changed.' }]
    case 'no_binding':
      return [{ id: newId(), kind: 'system', tone: 'warn', text: 'No knowledge source for this repo. Type /scan to create one first.' }]
    case 'failed':
      return [{ id: newId(), kind: 'system', tone: 'error', text: `/instrument failed: ${result.error}` }]
  }
}

function embedResultMessage(result: EmbedExitResult): ShellMessage[] {
  switch (result.kind) {
    case 'committed': {
      const lines = [
        `Embed committed on branch ${result.branch} (${result.sha.slice(0, 7)}).`,
        `Files changed: ${result.filesChanged.length}.`,
        `Before pushing: replace REPLACE_WITH_COPILOT_ID with a real copilot id from https://www.holostaff.ai/copilots.`,
        `Push when ready: git push -u origin ${result.branch}.`,
      ]
      return [{ id: newId(), kind: 'system', tone: 'success', text: lines.join('\n') }]
    }
    case 'cancelled':
      return [{ id: newId(), kind: 'system', tone: 'info', text: '/embed cancelled. Nothing was changed.' }]
    case 'no_binding':
      return [{ id: newId(), kind: 'system', tone: 'warn', text: 'No knowledge source for this repo. Type /scan to create one first.' }]
    case 'failed':
      return [{ id: newId(), kind: 'system', tone: 'error', text: `/embed failed: ${result.error}` }]
  }
}
