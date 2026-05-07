/**
 * Shared types for the conversational shell.
 *
 * One discriminated union per "thing the shell can show in scrollback":
 *   - user      The user's typed line (echoed so the assistant's reply
 *               has clear context above it).
 *   - assistant Streamed model output. `streaming: true` while deltas
 *               are arriving; flips false on completion. Same id used
 *               for both states so the UI replaces in place.
 *   - system    A neutral message from the shell itself — slash command
 *               output, scan/upload result summaries, errors.
 */

export type ShellMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'system'; text: string; tone?: 'info' | 'warn' | 'error' | 'success' }

export function newId(): string {
  // Unique enough for a single CLI session.
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}
