/**
 * Minimal interactive prompts — Node readline-based, no deps.
 *
 * Used for the "open deploy exists; force-push / wait / cancel" path
 * (deploy doc §5.4). The deploy command is otherwise non-interactive
 * by default to stay scriptable from CI.
 *
 * Port note: the published CLI uses Ink for interactive UIs. When
 * porting into the CLI repo, prefer Ink prompts for consistency with
 * the existing flows.
 */

import { createInterface } from 'node:readline'

export interface PromptOption<T extends string> {
  key: string       // '1', '2', '3', 'y', 'n', ...
  value: T
  label: string
}

export async function promptChoice<T extends string>(
  question: string,
  options: PromptOption<T>[],
): Promise<T | null> {
  if (!process.stdin.isTTY) return null

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const optionsLine = options.map(o => `[${o.key}] ${o.label}`).join('  ')
  const answer = await new Promise<string>(resolve => {
    rl.question(`\n${question}\n  ${optionsLine}\n  Choose: `, value => {
      rl.close()
      resolve(value.trim().toLowerCase())
    })
  })
  const match = options.find(o => o.key.toLowerCase() === answer)
  return match ? match.value : null
}
