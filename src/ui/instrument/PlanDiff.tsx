/**
 * PlanDiff — Ink view that previews an InstrumentationPlan.
 *
 * Shows summary, then per-op blocks:
 *   - install: package list + manager
 *   - create:  filename + truncated content preview
 *   - edit:    oldText replaced by newText, formatted as a unified-ish
 *              diff with leading "-"/"+" markers
 *
 * Scope: terminal-friendly preview, not a pixel-perfect diff. We're
 * showing the agent's *intent*; users who want the full picture can
 * read the file after the apply lands on the branch.
 */

import React from 'react'
import { Box, Text } from 'ink'
import type {
  CreateOp,
  EditOp,
  InstallOp,
  InstrumentOp,
  InstrumentationPlan,
} from '../../agent/instrument/instrumentSchema.js'

const PREVIEW_LINES = 12

export function PlanDiff({ plan }: { plan: InstrumentationPlan }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color="green">✓ </Text>
        <Text bold>Instrumentation plan</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{plan.summary}</Text>
      </Box>

      {plan.ops.map((op, i) => (
        <OpBlock key={i} op={op} index={i} />
      ))}

      {plan.coverageGaps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">Coverage gaps the agent flagged</Text>
          {plan.coverageGaps.map((g, i) => (
            <Box key={i} marginLeft={2}>
              <Text>▸ {g}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

function OpBlock({ op, index }: { op: InstrumentOp; index: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan">{`  ${index + 1}. `}</Text>
        <Text bold>{titleFor(op)}</Text>
      </Box>
      {(op.kind === 'create' || op.kind === 'edit') && op.reason && (
        <Box marginLeft={5}>
          <Text color="gray">{op.reason}</Text>
        </Box>
      )}
      <Box marginLeft={5} marginTop={1}>
        {op.kind === 'install' && <InstallPreview op={op} />}
        {op.kind === 'create' && <CreatePreview op={op} />}
        {op.kind === 'edit' && <EditPreview op={op} />}
      </Box>
    </Box>
  )
}

function titleFor(op: InstrumentOp): string {
  switch (op.kind) {
    case 'install':
      return `${op.packageManager} install ${op.packages.join(' ')}${op.dev ? ' (dev)' : ''}`
    case 'create':
      return `create ${op.file}`
    case 'edit':
      return `edit ${op.file}`
  }
}

function InstallPreview({ op }: { op: InstallOp }) {
  return (
    <Box flexDirection="column">
      <Text color="gray">Will be staged in package.json + lockfile when you run:</Text>
      <Text color="cyan">
        {`  ${op.packageManager} ${op.packageManager === 'yarn' ? 'add' : 'install'} ${op.packages.join(' ')}`}
      </Text>
    </Box>
  )
}

function CreatePreview({ op }: { op: CreateOp }) {
  const lines = op.content.split('\n')
  const previewLines = lines.slice(0, PREVIEW_LINES)
  const remaining = Math.max(0, lines.length - previewLines.length)
  return (
    <Box flexDirection="column">
      {previewLines.map((line, i) => (
        <Text key={i} color="green">+ {line}</Text>
      ))}
      {remaining > 0 && (
        <Text color="gray">  …{remaining} more line{remaining === 1 ? '' : 's'} elided</Text>
      )}
    </Box>
  )
}

function EditPreview({ op }: { op: EditOp }) {
  // Render oldText with leading '-' markers, newText with '+'.
  // For multi-line replacements, each line of the oldText/newText
  // gets its own marker line.
  const oldLines = op.oldText.split('\n').map((l) => `- ${l}`)
  const newLines = op.newText.split('\n').map((l) => `+ ${l}`)
  return (
    <Box flexDirection="column">
      {oldLines.map((line, i) => (
        <Text key={`o${i}`} color="red">{line}</Text>
      ))}
      {newLines.map((line, i) => (
        <Text key={`n${i}`} color="green">{line}</Text>
      ))}
    </Box>
  )
}
