/**
 * SourcePicker — Ink view shown when /scan --add-repo runs.
 *
 * Fetches the user's existing sources and lets them pick which one
 * the current repo should contribute to. Selection rebinds the local
 * .holostaff/source.json to the chosen source on successful upload
 * (the upload orchestrator handles the binding write).
 *
 * Empty states:
 *   - "no sources yet" — direct the user to /scan (without --add-repo)
 *     to create their first source.
 *   - failed list fetch — show error, let them cancel.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import SelectInput from 'ink-select-input'
import { listCliSources, type CliSourceSummary } from '../../auth/api.js'
import { resolveAuth } from '../../auth/credentials.js'

export interface SourcePickerProps {
  onPick: (source: { sourceId: string; sourceName: string }) => void
  onCancel: () => void
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'list'; sources: CliSourceSummary[] }
  | { kind: 'empty' }
  | { kind: 'failed'; error: string }

export function SourcePicker({ onPick, onCancel }: SourcePickerProps) {
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

    void listCliSources(auth.baseUrl, auth.token).then(({ sources }) => {
      if (!sources.length) {
        setPhase({ kind: 'empty' })
        return
      }
      setPhase({ kind: 'list', sources })
    }).catch((err) => {
      setPhase({ kind: 'failed', error: (err as Error).message })
    })
  }, [])

  switch (phase.kind) {
    case 'loading':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Loading your sources…</Text>
        </Box>
      )
    case 'failed':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">✗ Couldn't load sources</Text>
          <Text color="gray">{phase.error}</Text>
          <Box marginTop={1}><Text color="gray">Press Esc to cancel.</Text></Box>
        </Box>
      )
    case 'empty':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="yellow">! No sources in your workspace yet.</Text>
          <Text color="gray">
            /scan --add-repo merges into an existing source. Run /scan (no flags) here first to create one.
          </Text>
        </Box>
      )
    case 'list':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text bold>Add this repo to which source?</Text>
          <Box marginTop={1}>
            <Text color="gray">
              Subsequent /scan in this repo will merge into the source you pick. The local binding gets rewritten on save.
            </Text>
          </Box>
          <Box marginTop={1}>
            <SelectInput
              items={[
                ...phase.sources.map((s) => ({
                  label: formatSourceLabel(s),
                  value: s.id,
                  key: s.id,
                })),
                { label: '— Cancel —', value: '__cancel__', key: '__cancel__' },
              ]}
              onSelect={(item) => {
                if (item.value === '__cancel__') return onCancel()
                const picked = phase.sources.find((s) => s.id === item.value)
                if (!picked) return
                onPick({ sourceId: picked.id, sourceName: picked.name })
              }}
            />
          </Box>
        </Box>
      )
  }
}

function formatSourceLabel(s: CliSourceSummary): string {
  const ver = s.liveArtifactVersion ? `v${s.liveArtifactVersion}` : 'no live artifact'
  const origin = s.repoOrigin ? ` · ${s.repoOrigin}` : ''
  return `${s.name}  (${ver}${origin})`
}
