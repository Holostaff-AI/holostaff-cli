/**
 * Instrument — top-level Ink view orchestrating /instrument.
 *
 * State machine:
 *
 *   preflight       check binding + auth + env before anything else
 *   running         agent generates the plan
 *   reviewing       PlanDiff + prompt: [Y]/[N]
 *   applying        applyPlan() — git checkout -b + writes + commit
 *   done            success summary with branch name + next steps
 *   cancelled       user said no
 *   failed          something errored along the way
 *
 * The preflight is non-trivial: /instrument needs both a source binding
 * (so we know the workspace + sourceId to inject) AND a clean git tree
 * (so the apply step can branch + commit safely).
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'

import { runInstrument, type InstrumentEvent } from '../../agent/instrument/runInstrument.js'
import type { InstrumentationPlan } from '../../agent/instrument/instrumentSchema.js'
import { applyPlan, type ApplyEvent, type ApplyResult } from '../../instrument/applyPlan.js'
import { resolveAuth } from '../../auth/credentials.js'
import { readBinding } from '../../binding/sourceBinding.js'
import { emit, classifyError } from '../../telemetry.js'

export type InstrumentExitResult =
  | { kind: 'committed'; branch: string; sha: string; filesChanged: string[]; packagesToInstall: string[]; packageManager?: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'no_binding' }

export interface InstrumentProps {
  cwd: string
  onExit: (result: InstrumentExitResult) => void
}

type Phase =
  | { kind: 'preflight' }
  | {
      kind: 'running'
      ring: string[]
      filesRead: number
    }
  | { kind: 'reviewing'; plan: InstrumentationPlan }
  | {
      kind: 'applying'
      plan: InstrumentationPlan
      events: ApplyEvent[]
    }
  | { kind: 'done'; result: Extract<ApplyResult, { ok: true }> }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

export function Instrument({ cwd, onExit }: InstrumentProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' })
  const startedRef = useRef(false)
  const ctxRef = useRef<{ workspaceId: string; sourceId: string } | null>(null)
  const startedAtRef = useRef(Date.now())
  const telemetryEmittedRef = useRef(false)

  // Preflight: resolve auth + binding, then kick off the agent.
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

    // Kick off the agent.
    setPhase({ kind: 'running', ring: [], filesRead: 0 })

    void runInstrument({
      cwd,
      onEvent: (ev: InstrumentEvent) => {
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
        setPhase({
          kind: 'failed',
          error: `${result.reason}: ${result.error}`,
        })
        return
      }
      setPhase({ kind: 'reviewing', plan: result.plan })
    })
  }, [cwd])

  // Confirm prompt (Y/N) when reviewing.
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

  // Exit a beat after terminal states.
  useEffect(() => {
    if (phase.kind === 'cancelled') {
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({ command: 'instrument', outcome: 'canceled', durationMs: Date.now() - startedAtRef.current })
      }
      const t = setTimeout(() => onExit({ kind: 'cancelled' }), 1200)
      return () => clearTimeout(t)
    }
    if (phase.kind === 'failed') {
      const error = phase.error
      if (!telemetryEmittedRef.current) {
        telemetryEmittedRef.current = true
        emit({
          command: 'instrument',
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
        emit({ command: 'instrument', outcome: 'success', durationMs: Date.now() - startedAtRef.current })
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
        2500,
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
          <Text color="gray">Preparing /instrument…</Text>
        </Box>
      )
    case 'running':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Box>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text>{` Drafting an instrumentation plan  ·  ${phase.filesRead} files read`}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {phase.ring.map((line, i) => (
              <Text key={i} color="gray" dimColor>{line}</Text>
            ))}
          </Box>
        </Box>
      )
    case 'reviewing':
      return <ReviewView plan={phase.plan} />
    case 'applying':
      return <ApplyView events={phase.events} />
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
          <Text color="red">✗ /instrument failed</Text>
          <Text color="gray">{phase.error}</Text>
        </Box>
      )
  }
}

// ────────────────────────────────────────────────────────────────────────

function ReviewView({ plan }: { plan: InstrumentationPlan }) {
  // Imported lazily — small file with no side effects, but keeps the
  // top imports tight.
  const { PlanDiff } = require('./PlanDiff.js') as typeof import('./PlanDiff.js')
  return (
    <Box flexDirection="column">
      <PlanDiff plan={plan} />
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
}

function ApplyView({ events }: { events: ApplyEvent[] }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {events.map((ev, i) => (
        <ApplyLine key={i} ev={ev} />
      ))}
    </Box>
  )
}

function ApplyLine({ ev }: { ev: ApplyEvent }) {
  switch (ev.type) {
    case 'preflight':
      return <Text color="gray">· checking working tree…</Text>
    case 'tree_dirty':
      return <Text color="red">✗ working tree has uncommitted changes</Text>
    case 'branch_creating':
      return <Text color="gray">· creating branch {ev.name}</Text>
    case 'branch_created':
      return <Text color="green">✓ branch {ev.name} created</Text>
    case 'op_applying':
      return <Text color="gray">· applying op {ev.index + 1}/{ev.total}</Text>
    case 'op_applied':
      return <Text color="green">  ✓ op {ev.index + 1} applied</Text>
    case 'op_failed':
      return <Text color="red">  ✗ op {ev.index + 1} failed: {ev.error}</Text>
    case 'committing':
      return <Text color="gray">· committing changes</Text>
    case 'committed':
      return <Text color="green">✓ committed {ev.sha.slice(0, 7)} on {ev.branch}</Text>
    case 'rolled_back':
      return <Text color="yellow">↩ branch rolled back</Text>
    case 'failed':
      return <Text color="red">✗ {ev.error}</Text>
  }
}

function DoneView({ result }: { result: Extract<ApplyResult, { ok: true }> }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="green">✓ Instrumentation committed on {result.branch}</Text>
      <Box marginTop={1}>
        <Text color="gray">Commit: </Text>
        <Text>{result.sha.slice(0, 7)}</Text>
        <Text color="gray">  ·  </Text>
        <Text>{result.filesChanged.length} file{result.filesChanged.length === 1 ? '' : 's'} changed</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Next steps</Text>
        <Text color="gray">  Review the diff:</Text>
        <Text color="cyan">  {`  git diff main..${result.branch}`}</Text>
        {result.packagesToInstall.length > 0 && result.packageManager && (
          <>
            <Text color="gray">  Install the new dep on this branch:</Text>
            <Text color="cyan">{`    ${result.packageManager} ${result.packageManager === 'yarn' ? 'add' : 'install'} ${result.packagesToInstall.join(' ')}`}</Text>
          </>
        )}
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
  if (tool === 'mcp__holostaff__proposeInstrumentationPlan') return '→ submitting plan'
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
