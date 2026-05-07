/**
 * ScanProgress — Ink view shown while runScan() is streaming events.
 *
 * Three lines of live state:
 *   - elapsed timer
 *   - last action (the currently-active tool call or summary)
 *   - rolling counts of files read / routes seen
 *
 * Plus a scrolling ring of the last few activities, so the user gets
 * feedback that the agent is doing real work, not stuck.
 */

import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import type { ScanEvent } from '../../agent/runScan.js'

const RING_SIZE = 5

export interface ScanProgressState {
  current: string
  ring: string[]
  filesRead: number
  routesPreview: number
  componentsPreview: number
  elapsedMs: number
}

/**
 * Reduce the typed ScanEvent stream into the small state shape the
 * progress view renders. Pure — any component can consume the same
 * reducer (e.g. CI mode --quiet uses it for the JSON status object).
 */
export function reduceScanEvent(prev: ScanProgressState, ev: ScanEvent): ScanProgressState {
  switch (ev.type) {
    case 'started':
      return { ...prev, current: 'starting scan…' }
    case 'thinking':
      return {
        ...prev,
        current: ev.text.length > 80 ? ev.text.slice(0, 79) + '…' : ev.text,
        ring: pushRing(prev.ring, `· ${truncate(ev.text, 70)}`),
      }
    case 'tool_use': {
      const summary = summarizeToolUse(ev.tool, ev.input)
      return {
        ...prev,
        current: summary,
        filesRead: ev.tool === 'Read' ? prev.filesRead + 1 : prev.filesRead,
        ring: pushRing(prev.ring, `→ ${summary}`),
      }
    }
    case 'tool_result':
      return prev
    case 'submitted':
      return { ...prev, current: 'finalising artifact…' }
    case 'completed':
    case 'failed':
      return prev
  }
}

export const initialProgress: ScanProgressState = {
  current: 'preparing…',
  ring: [],
  filesRead: 0,
  routesPreview: 0,
  componentsPreview: 0,
  elapsedMs: 0,
}

function pushRing(ring: string[], item: string): string[] {
  const next = [...ring, item]
  return next.length > RING_SIZE ? next.slice(next.length - RING_SIZE) : next
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function summarizeToolUse(tool: string, input: unknown): string {
  if (tool === 'mcp__holostaff__detectFramework') return 'detecting framework'
  if (tool === 'mcp__holostaff__submitFindings') return 'submitting findings'
  if (tool === 'Read' && typeof input === 'object' && input !== null && 'file_path' in input) {
    return `read ${shortPath(String((input as { file_path?: string }).file_path ?? ''))}`
  }
  if (tool === 'Glob' && typeof input === 'object' && input !== null && 'pattern' in input) {
    return `glob ${String((input as { pattern?: string }).pattern ?? '')}`
  }
  if (tool === 'Grep' && typeof input === 'object' && input !== null && 'pattern' in input) {
    return `grep "${truncate(String((input as { pattern?: string }).pattern ?? ''), 40)}"`
  }
  if (tool === 'ToolSearch') return 'discovering tools'
  return tool
}

function shortPath(p: string): string {
  if (!p) return ''
  // Show last two segments — "client/src/views/HomeView.vue" → "views/HomeView.vue".
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return parts.slice(-2).join('/')
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

export function ScanProgress({ state }: { state: ScanProgressState }) {
  // Local elapsed counter so the timer ticks even between events.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = state.elapsedMs + tick * 1000

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text> Scanning</Text>
        <Text color="gray">  ·  </Text>
        <Text color="gray">{formatElapsed(elapsed)}</Text>
        <Text color="gray">  ·  </Text>
        <Text color="gray">{state.filesRead} files read</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">{state.current}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {state.ring.map((line, i) => (
          <Text key={i} color="gray" dimColor>{line}</Text>
        ))}
      </Box>
    </Box>
  )
}
