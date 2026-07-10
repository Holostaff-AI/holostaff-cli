import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { runDeviceFlow, type FlowEvent } from '../auth/deviceFlow.js'

/**
 * Login UI. Renders the device-flow with explicit, named steps — no
 * generic spinners. Tone matches PRD §4.8. On success calls onDone
 * so the parent can transition to the menu.
 */
export function Login({ baseUrl, repoName, onDone }: { baseUrl: string; repoName?: string; onDone: () => void }) {
  const { exit } = useApp()
  const [phase, setPhase] = useState<Phase>('idle')
  const [info, setInfo] = useState<{ uri?: string; code?: string; expiresAt?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [secondsElapsed, setSecondsElapsed] = useState(0)
  const [cancel, setCancel] = useState<(() => void) | null>(null)

  // ↵ to start; Esc / Ctrl-C to cancel before approval.
  useInput((input, key) => {
    if (phase === 'idle' && (key.return || input === 'y' || input === 'Y')) {
      startFlow()
    } else if (phase === 'awaiting' && (key.escape || key.ctrl && input === 'c')) {
      cancel?.()
      setPhase('cancelled')
      setTimeout(() => exit(), 80)
    } else if (phase === 'failed' && (key.return || input === 'r')) {
      setError(null)
      setPhase('idle')
      startFlow()
    } else if ((phase === 'failed' || phase === 'cancelled') && (key.escape || input === 'q')) {
      exit()
    }
  })

  function startFlow() {
    setPhase('starting')
    setInfo({})
    setError(null)
    setSecondsElapsed(0)

    const handle = runDeviceFlow({
      baseUrl,
      repoName,
      onEvent: handleEvent,
    })
    setCancel(() => handle.cancel)

    void handle.promise
  }

  function handleEvent(e: FlowEvent) {
    switch (e.type) {
      case 'started':
        setInfo({ uri: e.verificationUri, code: e.code, expiresAt: e.expiresAt })
        setPhase('awaiting')
        break
      case 'browser_opened':
        // Subsumed into the awaiting view; no separate state.
        break
      case 'browser_fallback':
        setPhase('awaiting_manual')
        break
      case 'polling':
        setSecondsElapsed(e.secondsElapsed)
        break
      case 'approved':
        setPhase('approved')
        // Brief pause so the user sees the success line, then continue.
        setTimeout(onDone, 600)
        break
      case 'failed':
        setError(e.reason)
        setPhase('failed')
        break
    }
  }

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {phase === 'idle' && <IdlePrompt />}
      {phase === 'starting' && <Text color="gray">⏵ Asking Holostaff for a one-time code...</Text>}
      {(phase === 'awaiting' || phase === 'awaiting_manual') && (
        <AwaitingApproval
          uri={info.uri ?? ''}
          code={info.code ?? ''}
          manual={phase === 'awaiting_manual'}
          secondsElapsed={secondsElapsed}
        />
      )}
      {phase === 'approved' && <Text color="green">✓ Connected to your Holostaff workspace.</Text>}
      {phase === 'failed' && <FailedView error={error ?? 'unknown error'} />}
      {phase === 'cancelled' && <Text color="yellow">Cancelled. See you later.</Text>}
    </Box>
  )
}

type Phase = 'idle' | 'starting' | 'awaiting' | 'awaiting_manual' | 'approved' | 'failed' | 'cancelled'

function IdlePrompt() {
  return (
    <Box flexDirection="column">
      <Text>First, I need to connect to your Holostaff workspace. New to Holostaff? Your account and workspace are created in your browser in one step.</Text>
      <Box marginTop={1}>
        <Text color="gray">Press </Text>
        <Text bold>Enter</Text>
        <Text color="gray"> to open your browser, or set </Text>
        <Text color="cyan">HOLOSTAFF_API_KEY</Text>
        <Text color="gray"> in your shell to use a CI key.</Text>
      </Box>
    </Box>
  )
}

function AwaitingApproval({
  uri, code, manual, secondsElapsed,
}: { uri: string; code: string; manual: boolean; secondsElapsed: number }) {
  return (
    <Box flexDirection="column">
      <Text>{manual
        ? 'Couldn\'t open your browser automatically. Please open this URL:'
        : 'Opened your browser. If it didn\'t pop up, here\'s the URL:'}</Text>
      <Box marginTop={1} marginLeft={2}>
        <Text color="cyan">{uri}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text>Code: </Text>
        <Text bold>{code}</Text>
        <Text color="gray"> (you'll see this on the page — it should match)</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">⏵ Waiting for confirmation... ({secondsElapsed}s)</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Press </Text>
        <Text bold>Esc</Text>
        <Text color="gray"> to cancel.</Text>
      </Box>
    </Box>
  )
}

function FailedView({ error }: { error: string }) {
  return (
    <Box flexDirection="column">
      <Text color="red">✗ {error}</Text>
      <Box marginTop={1}>
        <Text color="gray">Press </Text>
        <Text bold>Enter</Text>
        <Text color="gray"> to retry, or </Text>
        <Text bold>q</Text>
        <Text color="gray"> to quit.</Text>
      </Box>
    </Box>
  )
}
