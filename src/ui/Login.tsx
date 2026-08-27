import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { runDeviceFlow, noBrowserRequested, type FlowEvent } from '../auth/deviceFlow.js'

/**
 * Login UI. Renders the device-flow with explicit, named steps — no
 * generic spinners. Tone matches PRD §4.8. On success calls onDone
 * so the parent can transition to the menu.
 */
export function Login({ baseUrl, repoName, onDone }: { baseUrl: string; repoName?: string; onDone: () => void }) {
  const { exit } = useApp()
  const [phase, setPhase] = useState<Phase>('idle')
  const [info, setInfo] = useState<{ uri?: string; code?: string; expiresAt?: string }>({})
  const [identity, setIdentity] = useState<{ email?: string; workspaceName?: string; workspaceId?: string }>({})
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
        setIdentity({ email: e.email, workspaceName: e.workspaceName, workspaceId: e.workspaceId })
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
      {phase === 'approved' && <ApprovedLine {...identity} />}
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
        <Text color="yellow">Approve in the browser as the account you want to own this workspace. Signed in as someone else there? Sign out first, or open the URL in another profile.</Text>
      </Box>
      <Box marginTop={1}>
        {/* One Text with nested spans: sibling <Text> nodes in a row Box
            wrap independently at the terminal edge and drop characters
            ("PressEnte…") — nesting wraps as a single paragraph. */}
        <Text color="gray">Press <Text bold color="white">Enter</Text> to {noBrowserRequested() ? 'get a sign-in URL' : 'open your browser'}, or set <Text color="cyan">HOLOSTAFF_API_KEY</Text> in your shell to use a CI key. <Text color="cyan">HOLOSTAFF_NO_BROWSER=1</Text> prints the URL instead of opening a browser.</Text>
      </Box>
    </Box>
  )
}

function ApprovedLine({ email, workspaceName, workspaceId }: { email?: string; workspaceName?: string; workspaceId?: string }) {
  const ws = workspaceName ?? workspaceId
  if (!email && !ws) return <Text color="green">✓ Connected to your Holostaff workspace.</Text>
  return (
    <Text color="green">
      ✓ Signed in as <Text bold>{email ?? 'unknown account'}</Text> · workspace <Text bold>{ws ?? 'unknown'}</Text>
    </Text>
  )
}

function AwaitingApproval({
  uri, code, manual, secondsElapsed,
}: { uri: string; code: string; manual: boolean; secondsElapsed: number }) {
  return (
    <Box flexDirection="column">
      <Text>{manual
        ? (noBrowserRequested()
          ? 'Browser auto-open is off (HOLOSTAFF_NO_BROWSER). Open this URL in the profile you want to use:'
          : 'Couldn\'t open your browser automatically. Please open this URL:')
        : 'Opened your browser. If it didn\'t pop up, here\'s the URL:'}</Text>
      <Box marginTop={1} marginLeft={2}>
        <Text color="cyan">{uri}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text>Code: <Text bold>{code}</Text> <Text color="gray">(you'll see this on the page — it should match)</Text></Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">The page shows which account is approving. Make sure it is yours.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">⏵ Waiting for confirmation... ({secondsElapsed}s)</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Press <Text bold color="white">Esc</Text> to cancel.</Text>
      </Box>
    </Box>
  )
}

function FailedView({ error }: { error: string }) {
  return (
    <Box flexDirection="column">
      <Text color="red">✗ {error}</Text>
      <Box marginTop={1}>
        <Text color="gray">Press <Text bold color="white">Enter</Text> to retry, or <Text bold color="white">q</Text> to quit.</Text>
      </Box>
    </Box>
  )
}
