/**
 * Embed — top-level Ink view orchestrating /embed.
 *
 * Same state machine as Instrument: preflight → running → reviewing →
 * applying → done | cancelled | failed. Shares the apply machinery
 * (instrument/applyPlan.ts handles install/edit/create ops generically).
 *
 * Difference from /instrument: the customer needs to swap
 * REPLACE_WITH_COPILOT_ID for a real copilot id from the dashboard
 * after the branch lands. The DoneView surfaces that step explicitly.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'

import { runEmbed, type EmbedEvent } from '../../agent/embed/runEmbed.js'
import type { InstrumentationPlan } from '../../agent/instrument/instrumentSchema.js'
import { applyPlan, type ApplyEvent, type ApplyResult } from '../../instrument/applyPlan.js'
import { resolveAuth } from '../../auth/credentials.js'
import { readBinding } from '../../binding/sourceBinding.js'
import { emit, classifyError } from '../../telemetry.js'
import { PlanDiff } from '../instrument/PlanDiff.js'

export type EmbedExitResult =
  | {
      kind: 'committed'
      branch: string
      sha: string
      filesChanged: string[]
      packagesToInstall: string[]
      packageManager?: string
    }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'no_binding' }

export interface EmbedProps {
  cwd: string
  onExit: (result: EmbedExitResult) => void
}

type Phase =
  | { kind: 'preflight' }
  | { kind: 'running'; ring: string[]; filesRead: number }
  | { kind: 'reviewing'; plan: InstrumentationPlan }
  | { kind: 'applying'; plan: InstrumentationPlan; events: ApplyEvent[] }
  | { kind: 'done'; result: Extract<ApplyResult, { ok: true }> }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

export function Embed({ cwd, onExit }: EmbedProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' })
  const startedRef = useRef(false)
  const ctxRef = useRef<{ workspaceId: string; sourceId: string } | null>(null)
  const startedAtRef = useRef(Date.now())
  const telemetryEmittedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const auth = resolveAuth()
    if (auth.source === 'none' || auth.expired || !auth.workspaceId || !auth.token) {
      setPhase({ kind: 'failed', error: 'Not signed in. Run `/login` and try again.' })
      return
    }
    const read = readBinding(cwd, auth.workspaceId)
    if (read.kind !== 'found') {
      setPhase({
        kind: 'failed',
        error:
          read.kind === 'missing'
            ? 'No knowledge source bound to this repo. Run /scan first to create one.'
            : read.kind === 'wrong_workspace'
              ? `This repo's source belongs to a different workspace (${read.binding.workspaceId}).`
              : `Source binding is malformed: ${read.error}. Re-run /scan to recreate.`,
      })
      return
    }
    ctxRef.current = { workspaceId: auth.workspaceId, sourceId: read.binding.sourceId }

    setPhase({ kind: 'running', ring: [], filesRead: 0 })

    void runEmbed({
      cwd,
      onEvent: (ev: EmbedEvent) => {
        switch (ev.type) {
          case 'tool_use':
            setPhase((prev) =>
              prev.kind === 'running'
                ? {
                    ...prev,
                    filesRead: ev.tool === 'Read' ? prev.filesRead + 1 : prev.filesRead,
                    ring: pushRing(prev.ring, summarizeToolUse(ev.tool, ev.input)),
                  }
                : prev,
            )
            break
          case 'thinking':
            setPhase((prev) =>
              prev.kind === 'running'
                ? { ...prev, ring: pushRing(prev.ring, `· ${truncate(ev.text, 80)}`) }
                : prev,
            )
            break
        }
      },
    }).then((result) => {
      if (!result.ok) {
        setPhase({ kind: 'failed', error: `${result.reason}: ${result.error}` })
        return
      }
      setPhase({ kind: 'reviewing', plan: result.plan })
    })
  }, [cwd])

  useInput(
    (input, key) => {
      if (phase.kind !== 'reviewing') return
      if (key.escape) return setPhase({ kind: 'cancelled' })
      const ch = input.toLowerCase()
      if (ch === 'y') return void doApply()
      if (ch === 'n') return setPhase({ kind: 'cancelled' })
    },
    { isActive: phase.kind === 'reviewing' },
  )

  useEffect(() => {
    if (phase.kind === 'cancelled') {
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({ command: 'embed', outcome: 'canceled', durationMs: Date.now() - startedAtRef.current })
      }
      const t = setTimeout(() => onExit({ kind: 'cancelled' }), 1200)
      return () => clearTimeout(t)
    }
    if (phase.kind === 'failed') {
      const error = phase.error
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({
          command: 'embed',
          outcome: 'error',
          durationMs: Date.now() - startedAtRef.current,
          errorKind: classifyError(error),
        })
      }
      const isNoBinding = error.startsWith('No knowledge source bound')
      const t = setTimeout(
        () => onExit(isNoBinding ? { kind: 'no_binding' } : { kind: 'failed', error }),
        1500,
      )
      return () => clearTimeout(t)
    }
    if (phase.kind === 'done') {
      const r = phase.result
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({ command: 'embed', outcome: 'success', durationMs: Date.now() - startedAtRef.current })
      }
      const t = setTimeout(
        () =>
          onExit({
            kind: 'committed',
            branch: r.branch,
            sha: r.sha,
            filesChanged: r.filesChanged,
            packagesToInstall: r.packagesToInstall,
            packageManager: r.packageManager,
          }),
        // Longer beat than /instrument because the swap-the-id step
        // is critical and the user needs to read it.
        3500,
      )
      return () => clearTimeout(t)
    }
  }, [phase, onExit])

  async function doApply() {
    if (phase.kind !== 'reviewing' || !ctxRef.current) return
    const plan = phase.plan
    const ctx = ctxRef.current
    const events: ApplyEvent[] = []
    setPhase({ kind: 'applying', plan, events: [] })

    const result = await applyPlan({
      cwd,
      plan,
      // workspaceId/sourceId substitutions aren't used by /embed (the
      // agent emits literal REPLACE_WITH_COPILOT_ID), but we pass them
      // through anyway so a future plan that references them works.
      workspaceId: ctx.workspaceId,
      sourceId: ctx.sourceId,
      onEvent: (ev) => {
        events.push(ev)
        setPhase({ kind: 'applying', plan, events: [...events] })
      },
    })

    if (result.ok) {
      setPhase({ kind: 'done', result })
    } else {
      setPhase({ kind: 'failed', error: `${result.step}: ${result.error}` })
    }
  }

  switch (phase.kind) {
    case 'preflight':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Preparing /embed…</Text>
        </Box>
      )
    case 'running':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text>{` Drafting an embed plan  ·  ${phase.filesRead} files read`}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {phase.ring.map((line, i) => (
              <Text key={i} color="gray" dimColor>{line}</Text>
            ))}
          </Box>
        </Box>
      )
    case 'reviewing':
      return (
        <Box flexDirection="column">
          <PlanDiff plan={phase.plan} />
          <Box marginTop={1} marginLeft={2} flexDirection="column">
            <Text color="gray">───────────────────────────────────────────────────────────────</Text>
            <Box marginTop={1}>
              <Text>Apply this plan?</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Box><Text color="green">  [Y]</Text><Text>  Yes — create branch and commit</Text></Box>
              <Box><Text color="gray">  [N]</Text><Text color="gray">  No, cancel</Text></Box>
            </Box>
          </Box>
        </Box>
      )
    case 'applying':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {phase.events.map((ev, i) => (
            <ApplyLine key={i} ev={ev} />
          ))}
        </Box>
      )
    case 'done':
      return <DoneView result={phase.result} />
    case 'cancelled':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Cancelled. Nothing was changed.</Text>
        </Box>
      )
    case 'failed':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">✗ /embed failed</Text>
          <Text color="gray">{phase.error}</Text>
        </Box>
      )
  }
}

// ────────────────────────────────────────────────────────────────────────

function ApplyLine({ ev }: { ev: ApplyEvent }) {
  switch (ev.type) {
    case 'preflight':         return <Text color="gray">· checking working tree…</Text>
    case 'tree_dirty':        return <Text color="red">✗ working tree has uncommitted changes</Text>
    case 'branch_creating':   return <Text color="gray">· creating branch {ev.name}</Text>
    case 'branch_created':    return <Text color="green">✓ branch {ev.name} created</Text>
    case 'op_applying':       return <Text color="gray">· applying op {ev.index + 1}/{ev.total}</Text>
    case 'op_applied':        return <Text color="green">  ✓ op {ev.index + 1} applied</Text>
    case 'op_failed':         return <Text color="red">  ✗ op {ev.index + 1} failed: {ev.error}</Text>
    case 'committing':        return <Text color="gray">· committing changes</Text>
    case 'committed':         return <Text color="green">✓ committed {ev.sha.slice(0, 7)} on {ev.branch}</Text>
    case 'rolled_back':       return <Text color="yellow">↩ branch rolled back</Text>
    case 'failed':            return <Text color="red">✗ {ev.error}</Text>
  }
}

function DoneView({ result }: { result: Extract<ApplyResult, { ok: true }> }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="green">✓ Embed committed on {result.branch}</Text>
      <Box marginTop={1}>
        <Text color="gray">Commit: </Text>
        <Text>{result.sha.slice(0, 7)}</Text>
        <Text color="gray">  ·  </Text>
        <Text>{result.filesChanged.length} file{result.filesChanged.length === 1 ? '' : 's'} changed</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">Before pushing</Text>
        <Text color="gray">  Replace REPLACE_WITH_COPILOT_ID in the diff with a real copilot id from your dashboard:</Text>
        <Text color="cyan">{`    https://www.holostaff.ai/copilots`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Next steps</Text>
        <Text color="gray">  Review the diff:</Text>
        <Text color="cyan">  {`  git diff main..${result.branch}`}</Text>
        <Text color="gray">  Push when ready:</Text>
        <Text color="cyan">{`    git push -u origin ${result.branch}`}</Text>
      </Box>
    </Box>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function pushRing(ring: string[], item: string): string[] {
  const next = [...ring, item]
  return next.length > 5 ? next.slice(next.length - 5) : next
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function summarizeToolUse(tool: string, input: unknown): string {
  if (tool === 'mcp__holostaff__detectFramework') return '→ detecting framework'
  if (tool === 'mcp__holostaff__proposeEmbedPlan') return '→ submitting plan'
  if (tool === 'Read' && typeof input === 'object' && input !== null && 'file_path' in input) {
    const p = String((input as { file_path?: string }).file_path ?? '')
    return `→ read ${shortPath(p)}`
  }
  if (tool === 'Glob') return `→ glob`
  if (tool === 'Grep') return `→ grep`
  return `→ ${tool}`
}

function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : parts.slice(-2).join('/')
}
