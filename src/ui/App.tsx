import React, { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import SelectInput from 'ink-select-input'
import type { RepoDetection } from '../detect/repo.js'
import { Welcome } from './Welcome.js'

/**
 * Top-level Ink shell. v0.1 just renders the welcome banner and the
 * first-run picker; on pick we show a "this is what would happen"
 * stub since auth + scan aren't built yet. Subsequent passes wire
 * each branch to its real implementation.
 *
 * Layout matches PRD §4.1: welcome, then numeric menu, then a
 * picked-action context message.
 */

type Action = 'scan' | 'instrument' | 'embed' | 'chat'

interface MenuItem {
  label: string
  value: Action
  key?: string
}

const ITEMS: MenuItem[] = [
  { label: '1.  Scan this repo and add it to your knowledge base       (recommended)', value: 'scan',       key: 'scan' },
  { label: '2.  Scan + instrument (adds the Holostaff SDK to the code)',                value: 'instrument', key: 'instrument' },
  { label: '3.  Embed a copilot in this app',                                            value: 'embed',      key: 'embed' },
  { label: '4.  Just chat — show me what you can do',                                    value: 'chat',       key: 'chat' },
]

export function App({ detection, version }: { detection: RepoDetection; version: string }) {
  const { exit } = useApp()
  const [picked, setPicked] = useState<Action | null>(null)

  // Once a menu item is picked, we render its stub then schedule
  // a clean exit. The stub stays in scrollback so the user can act
  // on its instructions after we exit.
  useEffect(() => {
    if (!picked) return
    const t = setTimeout(() => exit(), 80)
    return () => clearTimeout(t)
  }, [picked, exit])

  return (
    <Box flexDirection="column">
      <Welcome detection={detection} version={version} />
      {picked
        ? <PickedStub action={picked} />
        : <Picker onSelect={(item) => setPicked(item.value)} />}
    </Box>
  )
}

function Picker({ onSelect }: { onSelect: (item: MenuItem) => void }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text>What would you like to do?</Text>
      <Box marginTop={1}>
        <SelectInput items={ITEMS} onSelect={onSelect} />
      </Box>
    </Box>
  )
}

function PickedStub({ action }: { action: Action }) {
  const message = STUBS[action]
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="cyan">› {actionLabel(action)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {message.map((line, i) => (
          <Text key={i} color={i === 0 ? undefined : 'gray'}>{line}</Text>
        ))}
      </Box>
    </Box>
  )
}

function actionLabel(a: Action): string {
  switch (a) {
    case 'scan':       return 'Scan'
    case 'instrument': return 'Scan + instrument'
    case 'embed':      return 'Embed a copilot'
    case 'chat':       return 'Chat'
  }
}

// Stub messages explain what *would* happen, in concrete steps. This
// is more useful than "not implemented" — users see the surface and
// know what's coming. Tone: PRD §4.8 — concise, names the work.
const STUBS: Record<Action, string[]> = {
  scan: [
    'When auth + scan ship, I will:',
    '  1. Confirm you\'re signed in to your Holostaff workspace',
    '  2. Read your code — routes, components, copy, brand',
    '  3. Synthesise the knowledge artifact',
    '  4. Show the trust report (what I\'ll send vs. what stays local)',
    '  5. Upload to your workspace',
    '',
    'For now, auth is the next thing to land. Re-run me after it ships.',
  ],
  instrument: [
    'When this is wired, I will run the scan above, then:',
    '  6. Generate Holostaff SDK init + tracking calls',
    '  7. Show you the diff before writing anything',
    '  8. Branch + commit + open a PR via gh',
    '',
    'For now, auth is the next thing to land. Re-run me after it ships.',
  ],
  embed: [
    'When this is wired, I will:',
    '  1. List your workspace\'s copilots',
    '  2. You pick one',
    '  3. I add the Holostaff widget to your app entry',
    '  4. Branch + commit + open a PR via gh',
    '',
    'For now, auth is the next thing to land. Re-run me after it ships.',
  ],
  chat: [
    'The conversational shell lands in milestone A3.',
    '',
    'When it ships, you\'ll be able to ask me what I\'m doing, why,',
    'and how each piece of the artifact gets used by your copilots.',
    '',
    'For now, the slash commands above are how things work.',
  ],
}
