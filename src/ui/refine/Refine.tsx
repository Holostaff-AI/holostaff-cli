/**
 * Refine — Ink view for editing the live artifact's identity overrides.
 *
 * Scope (A4 first push): productName, oneLineDescription, notes. The
 * other sections (routes, components, workflows, brandVoice) are
 * editable in the materio dashboard already — coming to /refine in a
 * follow-up if the terminal-first ergonomics matter enough.
 *
 * Flow:
 *   preflight   — read source binding for this repo
 *   loading     — GET /api/cli/sources/:id/artifacts/:liveVersion
 *   editing     — three text fields with their effective values
 *                 prefilled; arrow keys move between fields
 *   saving      — PATCH the merged customerEdits payload
 *   done        — success message with the dashboard link
 *   failed      — error surfaced; user re-runs to retry
 *
 * No agent involvement here — this is a focused form. A future
 * conversational-refine flow can layer on top using these same
 * server endpoints.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

import { getCliArtifact, patchCliArtifactEdits, type CliArtifact } from '../../auth/api.js'
import { resolveAuth } from '../../auth/credentials.js'
import { readBinding } from '../../binding/sourceBinding.js'
import { emit, classifyError } from '../../telemetry.js'

export type RefineExitResult =
  | { kind: 'saved'; viewUrl: string; sourceName: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'no_binding' }

export interface RefineProps {
  cwd: string
  onExit: (result: RefineExitResult) => void
}

type Phase =
  | { kind: 'preflight' }
  | { kind: 'loading'; sourceId: string; sourceName: string }
  | {
      kind: 'editing'
      sourceId: string
      sourceName: string
      version: number
      base: { productName: string; oneLineDescription: string; notes: string }
      effective: { productName: string; oneLineDescription: string; notes: string }
      existingEdits: Record<string, unknown>
      values: { productName: string; oneLineDescription: string; notes: string }
      focusIndex: 0 | 1 | 2 | 3 // 0=name, 1=desc, 2=notes, 3=actions
      saving: boolean
      saveError?: string
    }
  | { kind: 'done'; viewUrl: string; sourceName: string }
  | { kind: 'failed'; error: string }

const APP_BASE_URL = process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai'

export function Refine({ cwd, onExit }: RefineProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'preflight' })
  const startedRef = useRef(false)
  const startedAtRef = useRef(Date.now())
  const telemetryEmittedRef = useRef(false)

  function emitOnce(outcome: 'success' | 'error' | 'canceled', errorKind?: string) {
    if (telemetryEmittedRef.current) return
    telemetryEmittedRef.current = true
    emit({ command: 'refine', outcome, durationMs: Date.now() - startedAtRef.current, errorKind })
  }

  // Preflight: resolve auth + binding, then load the artifact.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const auth = resolveAuth()
    if (auth.source === 'none' || auth.expired || !auth.workspaceId || !auth.token) {
      setPhase({
        kind: 'failed',
        error: 'Not signed in. Run `holostaff login` and try again.',
      })
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
              ? `This repo's source belongs to a different workspace (${read.binding.workspaceId}). Switch workspace or re-bind via /scan.`
              : `Source binding is malformed: ${read.error}. Re-run /scan to recreate.`,
      })
      return
    }

    setPhase({ kind: 'loading', sourceId: read.binding.sourceId, sourceName: read.binding.name })

    void (async () => {
      try {
        // Look up the source to find the live version.
        const baseUrl = auth.baseUrl
        const bearer = auth.token!
        const { source } = await import('../../auth/api.js').then((m) =>
          m.getCliSource(baseUrl, bearer, read.binding.sourceId),
        )
        const version = source.liveArtifactVersion
        if (!version) {
          setPhase({
            kind: 'failed',
            error: 'No live artifact yet. Run /scan first to upload one.',
          })
          return
        }
        const { artifact } = await getCliArtifact(baseUrl, bearer, read.binding.sourceId, version)
        const eff = computeEffective(artifact)
        const existingEdits = (artifact.customerEdits ?? {}) as Record<string, unknown>
        setPhase({
          kind: 'editing',
          sourceId: read.binding.sourceId,
          sourceName: read.binding.name,
          version,
          base: {
            productName: artifact.productName,
            oneLineDescription: artifact.oneLineDescription,
            notes: artifact.notes ?? '',
          },
          effective: eff,
          existingEdits,
          values: { ...eff },
          focusIndex: 0,
          saving: false,
        })
      } catch (err) {
        setPhase({
          kind: 'failed',
          error: `Failed to load artifact: ${(err as Error).message}`,
        })
      }
    })()
  }, [cwd])

  // Exit a beat after a terminal state renders.
  useEffect(() => {
    if (phase.kind === 'done') {
      emitOnce('success')
      const t = setTimeout(
        () => onExit({ kind: 'saved', viewUrl: phase.viewUrl, sourceName: phase.sourceName }),
        2000,
      )
      return () => clearTimeout(t)
    }
    if (phase.kind === 'failed') {
      const error = phase.error
      emitOnce('error', classifyError(error))
      const isNoBinding =
        error.startsWith('No knowledge source bound')
        || error.startsWith('No live artifact')
      const t = setTimeout(
        () => onExit(isNoBinding ? { kind: 'no_binding' } : { kind: 'failed', error }),
        1200,
      )
      return () => clearTimeout(t)
    }
  }, [phase, onExit])

  // Top-level keys (Esc to cancel; Tab/Shift+Tab to move between fields)
  // are wired in the editing phase only.
  useInput(
    (input, key) => {
      if (phase.kind !== 'editing' || phase.saving) return
      if (key.escape) {
        emitOnce('canceled')
        return onExit({ kind: 'cancelled' })
      }
      if (key.tab && key.shift) {
        setPhase({ ...phase, focusIndex: prevIndex(phase.focusIndex) })
        return
      }
      if (key.tab) {
        setPhase({ ...phase, focusIndex: nextIndex(phase.focusIndex) })
        return
      }
      // On the actions row, accept y/s for save and n/c for cancel.
      if (phase.focusIndex === 3) {
        const ch = input.toLowerCase()
        if (ch === 's' || ch === 'y') return void doSave()
        if (ch === 'n' || ch === 'c') {
          emitOnce('canceled')
          return onExit({ kind: 'cancelled' })
        }
      }
    },
    { isActive: phase.kind === 'editing' && !phase.saving },
  )

  async function doSave() {
    if (phase.kind !== 'editing') return
    const auth = resolveAuth()
    if (!auth.token) {
      setPhase({ ...phase, saving: false, saveError: 'Lost auth — please re-login.' })
      return
    }

    setPhase({ ...phase, saving: true, saveError: undefined })

    // Compose the new customerEdits: start from existing, layer the
    // identity scalars on top. Empty values clear the override.
    const next: Record<string, unknown> = { ...phase.existingEdits }
    setOrClear(next, 'productName', phase.values.productName, phase.base.productName)
    setOrClear(next, 'oneLineDescription', phase.values.oneLineDescription, phase.base.oneLineDescription)
    setOrClear(next, 'notes', phase.values.notes, phase.base.notes)

    try {
      await patchCliArtifactEdits(auth.baseUrl, auth.token, phase.sourceId, phase.version, next)
      setPhase({
        kind: 'done',
        viewUrl: `${APP_BASE_URL.replace(/\/+$/, '')}/knowledge-sources/${encodeURIComponent(phase.sourceId)}`,
        sourceName: phase.sourceName,
      })
    } catch (err) {
      setPhase({ ...phase, saving: false, saveError: (err as Error).message })
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────

  switch (phase.kind) {
    case 'preflight':
      return <Centered>Resolving source…</Centered>
    case 'loading':
      return <Centered>Loading artifact for {phase.sourceName}…</Centered>
    case 'failed':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">✗ /refine failed</Text>
          <Text color="gray">{phase.error}</Text>
        </Box>
      )
    case 'done':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="green">✓ Refinements saved to {phase.sourceName}</Text>
          <Box marginTop={1}>
            <Text color="cyan">  View at </Text>
            <Text color="cyan" underline>{phase.viewUrl}</Text>
          </Box>
        </Box>
      )
    case 'editing':
      return (
        <EditingView
          phase={phase}
          onChange={(field, val) =>
            setPhase({ ...phase, values: { ...phase.values, [field]: val } })
          }
          onAdvance={() => setPhase({ ...phase, focusIndex: nextIndex(phase.focusIndex) })}
        />
      )
  }
}

// ────────────────────────────────────────────────────────────────────────

function EditingView({
  phase,
  onChange,
  onAdvance,
}: {
  phase: Extract<Phase, { kind: 'editing' }>
  onChange: (field: 'productName' | 'oneLineDescription' | 'notes', val: string) => void
  onAdvance: () => void
}) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text bold>Refine </Text>
        <Text color="gray">· {phase.sourceName} · v{phase.version}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Edit identity overrides for this artifact. Tab to move, Esc to cancel.
        </Text>
      </Box>

      <Field
        label="Product name"
        focused={phase.focusIndex === 0}
        value={phase.values.productName}
        baseValue={phase.base.productName}
        onChange={(v) => onChange('productName', v)}
        onSubmit={onAdvance}
        disabled={phase.saving}
      />
      <Field
        label="One-line description"
        focused={phase.focusIndex === 1}
        value={phase.values.oneLineDescription}
        baseValue={phase.base.oneLineDescription}
        onChange={(v) => onChange('oneLineDescription', v)}
        onSubmit={onAdvance}
        disabled={phase.saving}
      />
      <Field
        label="Notes"
        focused={phase.focusIndex === 2}
        value={phase.values.notes}
        baseValue={phase.base.notes}
        onChange={(v) => onChange('notes', v)}
        onSubmit={onAdvance}
        disabled={phase.saving}
        placeholder="Free-form context for the copilot — anything that doesn't fit elsewhere."
      />

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">───────────────────────────────────────────────────────────────</Text>
        <Box marginTop={1}>
          <Text color={phase.focusIndex === 3 ? 'cyan' : 'gray'}>
            {phase.focusIndex === 3 ? '> ' : '  '}
          </Text>
          <Text color={phase.focusIndex === 3 ? undefined : 'gray'}>
            [S] Save  ·  [N] Cancel
          </Text>
        </Box>
        {phase.saving && (
          <Box marginTop={1}>
            <Text color="cyan">Saving…</Text>
          </Box>
        )}
        {phase.saveError && (
          <Box marginTop={1}>
            <Text color="red">✗ {phase.saveError}</Text>
          </Box>
        )}
      </Box>

    </Box>
  )
}

function Field({
  label,
  focused,
  value,
  baseValue,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  label: string
  focused: boolean
  value: string
  baseValue: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
}) {
  const isOverride = value.trim().length > 0 && value.trim() !== baseValue.trim()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={focused ? 'cyan' : 'gray'}>{focused ? '> ' : '  '}</Text>
        <Text bold>{label}</Text>
        {isOverride && <Text color="yellow">  · overridden</Text>}
      </Box>
      <Box marginLeft={2}>
        {focused && !disabled
          ? <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
          : <Text color={value ? undefined : 'gray'}>{value || placeholder || '(empty)'}</Text>}
      </Box>
      {!isOverride && baseValue && value && (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>matches the scanned value</Text>
        </Box>
      )}
    </Box>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box marginTop={1} marginLeft={2}>
      <Text color="gray">{children}</Text>
    </Box>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function nextIndex(i: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  return ((i + 1) % 4) as 0 | 1 | 2 | 3
}
function prevIndex(i: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  return ((i + 3) % 4) as 0 | 1 | 2 | 3
}

function computeEffective(artifact: CliArtifact): {
  productName: string
  oneLineDescription: string
  notes: string
} {
  const e = (artifact.customerEdits ?? {}) as Record<string, unknown>
  const pn = typeof e.productName === 'string' && e.productName.trim().length > 0
    ? e.productName : artifact.productName
  const od = typeof e.oneLineDescription === 'string' && e.oneLineDescription.trim().length > 0
    ? e.oneLineDescription : artifact.oneLineDescription
  const nt = typeof e.notes === 'string'
    ? e.notes : (artifact.notes ?? '')
  return { productName: pn, oneLineDescription: od, notes: nt }
}

/**
 * Set or clear an edit field. Empty strings (or strings matching the
 * base) get *deleted* from customerEdits so we don't store no-op
 * overrides.
 */
function setOrClear(
  edits: Record<string, unknown>,
  key: string,
  value: string,
  baseValue: string,
): void {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === baseValue.trim()) {
    delete edits[key]
    return
  }
  edits[key] = value
}
