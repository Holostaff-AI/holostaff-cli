/**
 * InputBar — single-line text input pinned below the message list.
 *
 * Uses ink-text-input (already in the dep tree from A1) so we get
 * caret + arrow editing for free. Submit on Enter, clear on submit,
 * disable while a turn is in flight (parent passes `disabled`).
 *
 * Hint: when the buffer is empty, show a faint usage line under the
 * prompt to teach slash-commands without being intrusive.
 */

import React, { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

export interface InputBarProps {
  onSubmit: (text: string) => void
  /** True while the agent is responding — blocks input. */
  disabled?: boolean
  /** Hint shown below the prompt when the buffer is empty. */
  placeholder?: string
}

export function InputBar({ onSubmit, disabled, placeholder }: InputBarProps) {
  const [value, setValue] = useState('')

  function handleSubmit(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    setValue('')
    onSubmit(trimmed)
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={4}>
          <Text color={disabled ? 'gray' : 'cyan'}>{'  ❯ '}</Text>
        </Box>
        <Box flexGrow={1}>
          {disabled
            ? <Text color="gray">{value || placeholder || ''}</Text>
            : <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />}
        </Box>
      </Box>
      {!value && !disabled && placeholder && (
        <Box marginLeft={4}>
          <Text color="gray" dimColor>{placeholder}</Text>
        </Box>
      )}
    </Box>
  )
}
