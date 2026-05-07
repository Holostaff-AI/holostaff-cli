/**
 * TrustReport — Ink view shown after a scan completes successfully.
 *
 * The PRD calls this the trust report (§4.5). It exists so the user
 * can see what's about to leave their machine before we upload, and
 * decide. Three concrete outcomes from this screen:
 *
 *   [Y] Yes, send to your workspace      → onConfirm()
 *   [S] Save the artifact locally only   → onSaveLocal()
 *   [N] No, cancel                       → onCancel()
 *
 * Design notes:
 * - "What we'll send" enumerates the artifact's sections in concrete
 *   terms (not "metadata"). Counts beat adjectives.
 * - "What stays local" is non-negotiable language — the customer's
 *   source code, .env files, paths beyond what's in the artifact.
 *   We name them explicitly so the absence is felt.
 * - We sample five copy strings since copy is the most "real" content
 *   leaving the machine and the user benefits from seeing actual text.
 * - Coverage gaps render in full — they're an honesty signal and
 *   already authored to be terse.
 *
 * Pure display + a single keypress handler. No side effects beyond
 * the callback fire.
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import type { ScanFindings } from '../../agent/findingsSchema.js'

export interface TrustReportProps {
  findings: ScanFindings
  durationMs: number
  tokensIn: number
  tokensOut: number
  /** Called when the user picks [Y]. */
  onConfirm: () => void
  /** Called when the user picks [S]. */
  onSaveLocal: () => void
  /** Called when the user picks [N] or hits Esc. */
  onCancel: () => void
  /**
   * Disable input handling. Set during transitions (e.g. while we're
   * actually uploading after onConfirm). The view stays rendered so
   * the user can re-read what was sent.
   */
  inputDisabled?: boolean
}

const COPY_SAMPLE_SIZE = 5

export function TrustReport({
  findings,
  durationMs,
  tokensIn,
  tokensOut,
  onConfirm,
  onSaveLocal,
  onCancel,
  inputDisabled,
}: TrustReportProps) {
  // isActive=false avoids entering stdin raw mode entirely — important
  // for non-TTY environments (CI, snapshot tests) where raw mode throws.
  useInput((input, key) => {
    if (key.escape) return onCancel()
    const ch = input.toLowerCase()
    if (ch === 'y') return onConfirm()
    if (ch === 'n') return onCancel()
    if (ch === 's') return onSaveLocal()
  }, { isActive: !inputDisabled })

  const copySample = findings.copy.slice(0, COPY_SAMPLE_SIZE)
  const copyMore = Math.max(0, findings.copy.length - copySample.length)

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color="green">✓ </Text>
        <Text bold>Scan complete</Text>
        <Text color="gray">  ·  {(durationMs / 1000).toFixed(1)}s  ·  {tokensIn + tokensOut} tokens</Text>
      </Box>

      <Identity findings={findings} />

      <Section title="What we'll send to your Holostaff workspace">
        <Bullet label="Identity">product name, description, framework, language</Bullet>
        <Bullet label="Routes">{findings.routes.length} paths + descriptions</Bullet>
        <Bullet label="Components">{findings.components.length} names + roles</Bullet>
        <Bullet label="Copy">{findings.copy.length} customer-facing strings</Bullet>
        <Bullet label="Workflows">{findings.workflows.length} user flows + steps</Bullet>
        {findings.brandVoice && (
          <Bullet label="Brand voice">tone, keywords, words to avoid</Bullet>
        )}
        <Bullet label="Coverage">{findings.coverageGaps.length} explicit gaps the scan didn't reach</Bullet>
      </Section>

      <Section title="What stays on your machine" titleColor="green">
        <Plain>· Your source code — never sent</Plain>
        <Plain>· File contents (only paths and excerpted UI strings leave)</Plain>
        <Plain>· .env files, secrets, API keys</Plain>
        <Plain>· Git history</Plain>
      </Section>

      {copySample.length > 0 && (
        <Section title={`Sample copy (${copySample.length} of ${findings.copy.length})`}>
          {copySample.map((c, i) => (
            <Box key={i}>
              <Text>  </Text>
              <Text wrap="truncate">"{truncate(c.text, 60)}"</Text>
              <Text color="gray">  — {truncate(c.location, 36)}</Text>
            </Box>
          ))}
          {copyMore > 0 && <Text color="gray">  …+{copyMore} more</Text>}
        </Section>
      )}

      {findings.coverageGaps.length > 0 && (
        <Section title="Coverage gaps the scan reported" titleColor="yellow">
          {findings.coverageGaps.map((g, i) => (
            <Box key={i} marginLeft={2}>
              {/* Bullet + text in a single Text node so Ink's wrapping
                  doesn't eat whitespace at the sibling boundary. */}
              <Text>▸ {g}</Text>
            </Box>
          ))}
        </Section>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">───────────────────────────────────────────────────────────────</Text>
        <Box marginTop={1}>
          <Text>Send this to your Holostaff workspace?</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color="green">  [Y]</Text>
            <Text>  Yes, upload now</Text>
          </Box>
          <Box>
            <Text color="cyan">  [S]</Text>
            <Text>  Save artifact locally to .holostaff/scan.json (don't upload)</Text>
          </Box>
          <Box>
            <Text color="gray">  [N]</Text>
            <Text color="gray">  No, cancel</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Building blocks
// ────────────────────────────────────────────────────────────────────────

function Identity({ findings }: { findings: ScanFindings }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">{findings.productName}</Text>
      <Box>
        <Text color="gray">{findings.oneLineDescription}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{findings.primaryFramework} · {findings.language}</Text>
      </Box>
    </Box>
  )
}

function Section({
  title,
  titleColor,
  children,
}: {
  title: string
  titleColor?: string
  children: React.ReactNode
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={titleColor ?? 'white'}>{title}</Text>
      <Box flexDirection="column" marginTop={0}>{children}</Box>
    </Box>
  )
}

function Bullet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text>  • </Text>
      <Text bold>{label}: </Text>
      <Text color="gray">{children}</Text>
    </Box>
  )
}

function Plain({ children }: { children: React.ReactNode }) {
  return <Text color="gray">{children}</Text>
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}
