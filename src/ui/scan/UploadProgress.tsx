/**
 * UploadProgress — Ink view shown after the user confirms upload.
 *
 * Renders a step list with the current step animated, completed steps
 * checked, and on success a click-through URL. Three steps:
 *
 *   1. Resolve source  (find binding or create)
 *   2. Upload artifact
 *   3. Save binding    (only on first scan in a repo)
 *
 * The exact set of steps depends on the events the orchestrator emits;
 * we adapt the rendering rather than the orchestrator's semantics.
 */

import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import type { UploadEvent, UploadResult } from '../../agent/uploadArtifact.js'

export type UploadPhase =
  | { kind: 'starting' }
  | { kind: 'in_flight'; events: UploadEvent[] }
  | { kind: 'done'; result: UploadResult }

export function UploadProgress({ phase }: { phase: UploadPhase }) {
  if (phase.kind === 'starting') {
    return (
      <Box marginTop={1} marginLeft={2}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text>  Starting upload…</Text>
      </Box>
    )
  }

  if (phase.kind === 'in_flight') {
    return <InFlight events={phase.events} />
  }

  // Done — success or failure.
  const r = phase.result
  if (!r.ok) {
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <Text color="red">✗ Upload failed during {humanStep(r.step)}</Text>
        <Text color="gray">{r.error}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="green">
        ✓ Uploaded version {r.version}
        {r.isNewSource ? ` to new source “${r.sourceName}”` : ` to “${r.sourceName}”`}
      </Text>
      {r.isNewSource && (
        <Text color="gray">  Source binding saved to {shortHome(r.bindingPath)}</Text>
      )}
      <Box marginTop={1}>
        <Text color="cyan">  View at </Text>
        <Text color="cyan" underline>{r.viewUrl}</Text>
      </Box>
    </Box>
  )
}

function InFlight({ events }: { events: UploadEvent[] }) {
  // Pick the most informative current line from the latest event.
  const current = events[events.length - 1]
  const checks = collectChecks(events)

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {checks.map((c, i) => (
        <Box key={i}>
          <Text color="green">  ✓ </Text>
          <Text>{c}</Text>
        </Box>
      ))}
      {current && !isTerminal(current) && (
        <Box>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>  {labelFor(current)}</Text>
        </Box>
      )}
    </Box>
  )
}

function collectChecks(events: UploadEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    if (ev.type === 'reusing_source') out.push(`Using existing source “${ev.name}” (${ev.sourceId})`)
    if (ev.type === 'source_created') out.push(`Created source “${ev.name}” (${ev.sourceId})`)
    if (ev.type === 'uploaded') out.push(`Uploaded artifact version ${ev.version}`)
    if (ev.type === 'binding_written') out.push(`Saved binding`)
  }
  return out
}

function isTerminal(ev: UploadEvent): boolean {
  return ev.type === 'binding_written' || ev.type === 'failed' || ev.type === 'uploaded'
}

function labelFor(ev: UploadEvent): string {
  switch (ev.type) {
    case 'resolving_source':       return 'Resolving knowledge source…'
    case 'reusing_source':         return `Using ${ev.name}…`
    case 'creating_source':        return `Creating knowledge source “${ev.name}”…`
    case 'source_created':         return `Source ${ev.name} created`
    case 'uploading':              return `Uploading artifact…`
    case 'wrong_workspace_binding':return 'Existing binding is for a different workspace; creating a new one…'
    case 'binding_malformed':      return `Binding file was malformed (${ev.error}); recreating…`
    case 'binding_written':        return 'Saved binding'
    case 'uploaded':               return 'Done'
    case 'failed':                 return `Failed: ${ev.error}`
  }
}

function humanStep(s: 'resolve_source' | 'upload' | 'persist_binding'): string {
  switch (s) {
    case 'resolve_source':  return 'source resolution'
    case 'upload':          return 'artifact upload'
    case 'persist_binding': return 'binding save'
  }
}

function shortHome(p: string): string {
  const home = process.env.HOME ?? ''
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p
}
