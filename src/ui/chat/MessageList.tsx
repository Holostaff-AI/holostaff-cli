/**
 * MessageList — vertical scrollback of shell messages.
 *
 * Each message renders with a role badge in the gutter, then the body
 * to the right with terminal-style wrapping. System messages get a
 * tone-coloured marker (info/warn/error/success).
 *
 * Ink doesn't scroll on its own — we just append and let the terminal
 * scroll naturally as the buffer grows. That's the right model for a
 * shell: history is in the terminal scrollback, not a windowed widget.
 */

import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import type { ShellMessage } from './types.js'

export function MessageList({ messages }: { messages: ShellMessage[] }) {
  return (
    <Box flexDirection="column">
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
    </Box>
  )
}

function Message({ message }: { message: ShellMessage }) {
  switch (message.kind) {
    case 'user':
      return (
        <Box flexDirection="row" marginTop={1}>
          <Box width={4}>
            <Text color="cyan">{'  > '}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text>{message.text}</Text>
          </Box>
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="row" marginTop={1}>
          <Box width={4}>
            {message.streaming
              ? <Text color="magenta"><Spinner type="dots" /></Text>
              : <Text color="magenta">{'  ● '}</Text>}
          </Box>
          <Box flexGrow={1}>
            <Text>{message.text || ' '}</Text>
          </Box>
        </Box>
      )
    case 'system': {
      const color = toneColor(message.tone)
      const glyph = toneGlyph(message.tone)
      return (
        <Box flexDirection="row" marginTop={1}>
          <Box width={4}>
            <Text color={color}>{`  ${glyph} `}</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {message.text.split('\n').map((line, i) => (
              <Text key={i} color={message.tone === 'error' ? 'red' : undefined}>{line}</Text>
            ))}
          </Box>
        </Box>
      )
    }
  }
}

type Tone = 'info' | 'warn' | 'error' | 'success' | undefined

function toneColor(tone: Tone): string {
  switch (tone) {
    case 'success': return 'green'
    case 'warn':    return 'yellow'
    case 'error':   return 'red'
    case 'info':
    default:        return 'gray'
  }
}

function toneGlyph(tone: Tone): string {
  switch (tone) {
    case 'success': return '✓'
    case 'warn':    return '!'
    case 'error':   return '✗'
    case 'info':
    default:        return '·'
  }
}
