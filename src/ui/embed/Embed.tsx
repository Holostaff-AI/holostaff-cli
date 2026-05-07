/**
 * Embed — top-level Ink view orchestrating /embed.
 *
 * State machine: preflight → picking_copilot → running → reviewing →
 * applying → pushing_pr → done | cancelled | failed.
 *
 * The picker fetches /api/cli/copilots so the user binds the snippet
 * to a specific copilot up front. We substitute the chosen id into
 * the agent's REPLACE_WITH_COPILOT_ID placeholder at apply time, so
 * the PR carries a real id (no manual edit required pre-push).
 *
 * On a successful PR open we POST /api/cli/embed-state so the
 * dashboard's Copilots page can surface "PR open" status.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'

import { runEmbed, type EmbedEvent } from '../../agent/embed/runEmbed.js'
import type { InstrumentationPlan } from '../../agent/instrument/instrumentSchema.js'
import { applyPlan, type ApplyEvent, type ApplyResult } from '../../instrument/applyPlan.js'
import { openPullRequest, type PrResult } from '../../instrument/openPullRequest.js'
import { setEmbedState } from '../../auth/api.js'
import { resolveAuth } from '../../auth/credentials.js'
import { readBinding } from '../../binding/sourceBinding.js'
import { emit, classifyError } from '../../telemetry.js'
import { PlanDiff } from '../instrument/PlanDiff.js'
import { CopilotPicker } from './CopilotPicker.js'

export type EmbedExitResult =
  | {
      kind: 'committed'
      branch: string
      sha: string
      filesChanged: string[]
      packagesToInstall: string[]
      packageManager?: string
      copilotId: string
      copilotName: string
      pr?: PrResult
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
  | { kind: 'picking_copilot' }
  | { kind: 'running'; ring: string[]; filesRead: number }
  | { kind: 'reviewing'; plan: InstrumentationPlan }
  | { kind: 'applying'; plan: InstrumentationPlan; events: ApplyEvent[] }
  | { kind: 'pushing_pr'; result: Extract<ApplyResult, { ok: true }> }
  | { kind: 'done'; result: Extract<ApplyResult, { ok: true }>; pr?: PrResult }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

export function Embed({ cwd, onExit }: EmbedProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' })
  const startedRef = useRef(false)
  const ctxRef = useRef<{
    workspaceId: string
    sourceId: string
    bearer: string
    baseUrl: string
    copilotId?: string
    copilotName?: string
  } | null>(null)
  const startedAtRef = useRef(Date.now())
  const telemetryEmittedRef = useRef(false)

  // Preflight: check auth + source binding, then move to picker.
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
    ctxRef.current = {
      workspaceId: auth.workspaceId,
      sourceId: read.binding.sourceId,
      bearer: auth.token,
      baseUrl: auth.baseUrl,
    }

    setPhase({ kind: 'picking_copilot' })
  }, [cwd])

  function startAgent() {
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
  }

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
      const pr = phase.pr
      const ctx = ctxRef.current
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
            copilotId: ctx?.copilotId ?? '',
            copilotName: ctx?.copilotName ?? '',
            pr,
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
      // The picker stored the chosen copilot in ctx; applyPlan swaps
      // REPLACE_WITH_COPILOT_ID for it as it writes the snippet.
      workspaceId: ctx.workspaceId,
      sourceId: ctx.sourceId,
      copilotId: ctx.copilotId,
      onEvent: (ev) => {
        events.push(ev)
        setPhase({ kind: 'applying', plan, events: [...events] })
      },
    })

    if (!result.ok) {
      setPhase({ kind: 'failed', error: `${result.step}: ${result.error}` })
      return
    }

    setPhase({ kind: 'pushing_pr', result })
    const pr = await openPullRequest({
      cwd,
      branch: result.branch,
      title: `chore(holostaff): embed copilot${ctx.copilotName ? ` ${ctx.copilotName}` : ''}`,
      body: composePrBody(plan, result, ctx.copilotName ?? '', ctx.copilotId ?? ''),
    })

    // Tell the dashboard the embed lifecycle has advanced. Best-effort
    // — we never fail the flow on a tracking write.
    if (ctx.copilotId) {
      try {
        await setEmbedState(ctx.baseUrl, ctx.bearer, {
          copilotId: ctx.copilotId,
          sourceId: ctx.sourceId,
          phase: 'pr_open',
          prUrl: pr.kind === 'opened' ? pr.url : undefined,
          prState: pr.kind === 'opened' ? 'open' : undefined,
        })
      } catch {
        // Ignore — dashboard will still show "Not embedded" until the
        // next /embed run; not worth interrupting the user.
      }
    }

    setPhase({ kind: 'done', result, pr })
  }

  switch (phase.kind) {
    case 'preflight':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray">Preparing /embed…</Text>
        </Box>
      )
    case 'picking_copilot':
      return (
        <CopilotPicker
          onPick={(c) => {
            if (ctxRef.current) {
              ctxRef.current.copilotId = c.id
              ctxRef.current.copilotName = c.name
            }
            startAgent()
          }}
          onCancel={() => setPhase({ kind: 'cancelled' })}
        />
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
    case 'pushing_pr':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="green">✓ committed {phase.result.sha.slice(0, 7)} on {phase.result.branch}</Text>
          <Box marginTop={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text> Pushing branch and opening a pull request…</Text>
          </Box>
        </Box>
      )
    case 'done':
      return <DoneView result={phase.result} pr={phase.pr} copilotName={ctxRef.current?.copilotName ?? ''} />
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

function DoneView({
  result,
  pr,
  copilotName,
}: {
  result: Extract<ApplyResult, { ok: true }>
  pr?: PrResult
  copilotName: string
}) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="green">
        ✓ Embed committed on {result.branch}{copilotName ? ` for ${copilotName}` : ''}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">Commit: </Text>
        <Text>{result.sha.slice(0, 7)}</Text>
        <Text color="gray">  ·  </Text>
        <Text>{result.filesChanged.length} file{result.filesChanged.length === 1 ? '' : 's'} changed</Text>
      </Box>
      {pr?.kind === 'opened' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="green">✓ Pull request opened</Text>
          <Text color="cyan">  {pr.url}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Next steps</Text>
        <Text color="gray">  Review the diff:</Text>
        <Text color="cyan">  {`  git diff main..${result.branch}`}</Text>
        {pr?.kind !== 'opened' && (
          <>
            <Text color="gray">  Push when ready:</Text>
            <Text color="cyan">{`    git push -u origin ${result.branch}`}</Text>
            {pr?.kind === 'skipped' && (
              <Text color="gray">  ({prSkipHint(pr.reason)})</Text>
            )}
            {pr?.kind === 'failed' && (
              <Text color="yellow">  (couldn't open PR automatically: {pr.error})</Text>
            )}
          </>
        )}
        <Text color="gray">  After your build deploys, mark this copilot embedded in your dashboard:</Text>
        <Text color="cyan">{`    https://www.holostaff.ai/copilots`}</Text>
      </Box>
    </Box>
  )
}

function prSkipHint(reason: 'gh_missing' | 'gh_unauthed' | 'no_remote'): string {
  switch (reason) {
    case 'gh_missing':  return 'install GitHub CLI to auto-open a PR: https://cli.github.com'
    case 'gh_unauthed': return 'run `gh auth login` to auto-open a PR next time'
    case 'no_remote':   return 'no `origin` remote — add one and re-run'
  }
}

/** Short PR body for /embed. The reviewer sees which copilot is wired
 * and which files changed; long-form context lives in the dashboard. */
function composePrBody(
  plan: InstrumentationPlan,
  result: Extract<ApplyResult, { ok: true }>,
  copilotName: string,
  copilotId: string,
): string {
  const lines = [
    `Generated by \`holostaff /embed\`.`,
    ``,
    `Wires the Holostaff widget for **${copilotName || copilotId}** into this app.`,
    `Visitors will see this copilot once the branch merges and the build deploys.`,
    ``,
    `**Files changed (${result.filesChanged.length}):**`,
    ...result.filesChanged.map((f) => `- \`${f}\``),
  ]
  if (result.packagesToInstall.length && result.packageManager) {
    const pm = result.packageManager
    const cmd = `${pm} ${pm === 'yarn' ? 'add' : 'install'} ${result.packagesToInstall.join(' ')}`
    lines.push('', `**Run on this branch before merging:**`, '```', cmd, '```')
  }
  if (plan.coverageGaps?.length) {
    lines.push('', `**Coverage gaps the agent flagged:**`)
    for (const g of plan.coverageGaps) lines.push(`- ${g}`)
  }
  return lines.join('\n')
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
