/**
 * CopilotPicker — fetched at the start of /embed so the user picks
 * which copilot the snippet will bind to. Substituted into the agent's
 * REPLACE_WITH_COPILOT_ID placeholder before applyPlan writes files.
 *
 * Empty workspaces are handled: if there are no copilots, we direct
 * the user to create one in the dashboard rather than letting them
 * proceed with a placeholder we'd have to ask them to swap manually.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import SelectInput from 'ink-select-input'
import { listCopilots, type CopilotSummary } from '../../auth/api.js'
import { resolveAuth } from '../../auth/credentials.js'

export interface CopilotPickerProps {
  onPick: (copilot: { id: string; name: string }) => void
  onCancel: () => void
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'list'; copilots: CopilotSummary[] }
  | { kind: 'empty' }
  | { kind: 'failed'; error: string }

const APP_BASE_URL = process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai'

export function CopilotPicker({ onPick, onCancel }: CopilotPickerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const auth = resolveAuth()
    if (auth.source === 'none' || auth.expired || !auth.token) {
      setPhase({ kind: 'failed', error: 'Not signed in. Run `/login` first.' })
      return
    }

    void listCopilots(auth.baseUrl, auth.token).then(({ copilots }) => {
      if (!copilots.length) {
        setPhase({ kind: 'empty' })
        return
      }
      setPhase({ kind: 'list', copilots })
    }).catch((err) => {
      setPhase({ kind: 'failed', error: (err as Error).message })
    })
  }, [])

  switch (phase.kind) {
    case 'loading':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Loading your copilots…</Text>
        </Box>
      )
    case 'failed':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">✗ Couldn't load copilots</Text>
          <Text color="gray">{phase.error}</Text>
          <Box marginTop={1}><Text color="gray">Press Esc to cancel.</Text></Box>
        </Box>
      )
    case 'empty':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="yellow">! No copilots in this workspace yet.</Text>
          <Text color="gray">Create one first:</Text>
          <Text color="cyan">  {APP_BASE_URL}/copilots</Text>
          <Box marginTop={1}><Text color="gray">Press Esc to cancel.</Text></Box>
        </Box>
      )
    case 'list':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text bold>Which copilot should we embed?</Text>
          <Box marginTop={1}>
            <Text color="gray">
              The chosen copilot's id is baked into the embed snippet — visitors will see this copilot.
            </Text>
          </Box>
          <Box marginTop={1}>
            <SelectInput
              items={[
                ...phase.copilots.map((c) => ({
                  label: formatCopilotLabel(c),
                  value: c.id,
                  key: c.id,
                })),
                { label: '— Cancel —', value: '__cancel__', key: '__cancel__' },
              ]}
              onSelect={(item) => {
                if (item.value === '__cancel__') return onCancel()
                const picked = phase.copilots.find((c) => c.id === item.value)
                if (!picked) return
                onPick({ id: picked.id, name: picked.name })
              }}
            />
          </Box>
        </Box>
      )
  }
}

function formatCopilotLabel(c: CopilotSummary): string {
  const status = c.status ? ` · ${c.status}` : ''
  return `${c.name}${status}`
}
