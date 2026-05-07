/**
 * submitFindings — the agent's exit tool. Calling it locks in the
 * structured artifact and signals the scan is complete.
 *
 * Why a tool instead of "ask the model to emit JSON in its final
 * message": tool-call inputs are validated against the Zod schema by
 * the SDK, the structure survives without prose-parsing, and the
 * "agent is done" signal is unambiguous (vs. trying to detect
 * end-of-scan from free-form assistant text).
 *
 * The handler stores the validated findings in a closure-captured
 * sink supplied by runScan(). The first valid call wins; later calls
 * are rejected so the agent doesn't accidentally overwrite.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { ScanFindingsSchema, type ScanFindings } from '../findingsSchema.js'

export interface FindingsSink {
  /** Called once when the agent submits validated findings. */
  capture(findings: ScanFindings): void
  /** True after capture() has fired. */
  isCaptured(): boolean
}

export function makeSubmitFindingsTool(sink: FindingsSink) {
  return tool(
    'submitFindings',
    [
      'Submit the final structured knowledge artifact. Call this EXACTLY ONCE',
      'when your scan is complete. After calling it, the scan is done — do not',
      'invoke any further tools. The arguments are validated against the',
      'artifact schema; if the call fails validation, fix the issue and call',
      'again with the corrected payload.',
    ].join(' '),
    ScanFindingsSchema.shape,
    async (args) => {
      // The SDK validates `args` against the Zod shape before we get here.
      // Defensive re-validation in case the SDK ever loosens that contract.
      const parsed = ScanFindingsSchema.safeParse(args)
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `submitFindings rejected: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}. Fix the payload and call again.`,
            },
          ],
          isError: true,
        }
      }
      if (sink.isCaptured()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'submitFindings already received the final artifact. The scan is complete; do not call again.',
            },
          ],
          isError: true,
        }
      }
      sink.capture(parsed.data)
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Findings accepted. Scan complete — no further tool calls needed.',
          },
        ],
      }
    },
  )
}
