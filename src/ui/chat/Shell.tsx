/**
 * Shell — conversational top-level for the CLI.
 *
 * Replaces the numeric menu from A1: input bar at the bottom, scrolling
 * message history above, slash commands intercepted before the chat
 * agent is called.
 *
 * Lifecycle:
 *   - Empty input ⇒ noop
 *   - Starts with '/' ⇒ dispatchSlash → either append a system
 *     message or emit a shell-action ('open_scan' | 'reauth' | 'exit')
 *     for the parent to handle.
 *   - Anything else ⇒ runChat with the prior session id; stream deltas
 *     into a single assistant message that flips streaming:false on
 *     completion.
 *
 * No tool execution here. /scan owns the only filesystem-touching
 * pathway today; A4/A5/A6 add /refine, /instrument, /embed flows
 * which will live alongside as separate orchestrators.
 */

import React, { useState } from 'react'
import { Box, Text, useApp } from 'ink'

import { dispatchSlash, type SlashOutcome } from '../../commands/slash.js'
import { runChat } from '../../agent/runChat.js'
import { MessageList } from './MessageList.js'
import { InputBar } from './InputBar.js'
import { newId, type ShellMessage } from './types.js'

export type ShellAction = 'open_scan' | 'open_refine' | 'open_instrument' | 'reauth' | 'exit'

export interface ShellProps {
  /** Messages to seed the scrollback with — used after returning from /scan. */
  initialMessages?: ShellMessage[]
  /**
   * Called on shell-level transitions. The parent (App) decides how to
   * handle them — open_scan switches to <Scan/>, reauth re-runs the
   * device flow, exit unmounts.
   *
   * `args` is the raw text after the slash command (e.g. '--add-repo'
   * for /scan). Parent parses what it needs.
   *
   * Returns updated history if the parent wants to mutate scrollback
   * (e.g. after /scan completes the parent appends a result message).
   */
  onAction: (action: ShellAction, args: string, history: ShellMessage[]) => void
}

export function Shell({ initialMessages, onAction }: ShellProps) {
  const { exit } = useApp()
  const [messages, setMessages] = useState<ShellMessage[]>(initialMessages ?? defaultGreeting())
  const [busy, setBusy] = useState(false)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)

  async function handleSubmit(text: string) {
    if (busy) return

    // Echo the user's line.
    const userMsg: ShellMessage = { id: newId(), kind: 'user', text }
    const after = [...messages, userMsg]
    setMessages(after)

    if (text.startsWith('/')) {
      const outcome: SlashOutcome = await dispatchSlash(text)
      if (outcome.kind === 'message') {
        setMessages((prev) => [
          ...prev,
          { id: newId(), kind: 'system', text: outcome.text, tone: outcome.tone },
        ])
        return
      }
      // Action — let the parent take over. Pass current history so it
      // can be restored / appended to on return.
      if (outcome.action === 'exit') return exit()
      onAction(outcome.action, outcome.args ?? '', after)
      return
    }

    // Free-form: stream the model response into a fresh assistant
    // message. We mutate `setMessages` on every delta so the UI re-renders.
    setBusy(true)
    const assistantId = newId()
    setMessages((prev) => [
      ...prev,
      { id: assistantId, kind: 'assistant', text: '', streaming: true },
    ])

    let acc = ''
    await runChat({
      prompt: text,
      resume: sessionId,
      onEvent: (ev) => {
        if (ev.type === 'session') {
          setSessionId(ev.sessionId)
          return
        }
        if (ev.type === 'delta') {
          acc += ev.text
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && m.kind === 'assistant'
                ? { ...m, text: acc }
                : m,
            ),
          )
          return
        }
        if (ev.type === 'failed') {
          setMessages((prev) =>
            prev
              .filter((m) => m.id !== assistantId)
              .concat([
                { id: newId(), kind: 'system', tone: 'error', text: ev.error },
              ]),
          )
          return
        }
        if (ev.type === 'completed') {
          if (ev.sessionId && !sessionId) setSessionId(ev.sessionId)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && m.kind === 'assistant'
                ? { ...m, streaming: false }
                : m,
            ),
          )
        }
      },
    })
    setBusy(false)
  }

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      <InputBar
        onSubmit={handleSubmit}
        disabled={busy}
        placeholder="type a question or a /command — /help to list, /quit to exit"
      />
      {busy && (
        <Box marginTop={0} marginLeft={4}>
          <Text color="gray" dimColor>thinking…</Text>
        </Box>
      )}
    </Box>
  )
}

function defaultGreeting(): ShellMessage[] {
  return [
    {
      id: newId(),
      kind: 'system',
      tone: 'info',
      text:
        'Holostaff CLI. Type /scan to scan this repo, /help for the full command list, or just ask me a question.',
    },
  ]
}
