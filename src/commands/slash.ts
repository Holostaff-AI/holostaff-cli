/**
 * Slash command dispatcher for the conversational shell.
 *
 * Two outcomes a handler can produce:
 *   - 'message' — append a system-tone message to scrollback.
 *   - 'action'  — signal a shell-level transition (scan flow, exit).
 *
 * Slash commands are pure-text first; flows that take over the screen
 * (like /scan) emit a {kind:'action', action:'open_scan'} for the
 * shell's parent to handle.
 *
 * Unknown commands produce a 'message' with a hint, never throw — the
 * shell stays usable.
 */

import { formatWhoami, formatWorkspace } from './text.js'
import { clearCredentials, credentialsPath } from '../auth/credentials.js'

export type SlashOutcome =
  | { kind: 'message'; text: string; tone?: 'info' | 'warn' | 'error' | 'success' }
  | { kind: 'action'; action: 'open_scan' | 'open_refine' | 'exit' | 'reauth'; args?: string }

export interface SlashCommand {
  /** Canonical name including leading slash, e.g. '/scan'. */
  name: string
  /** One-line description shown in /help. */
  desc: string
  /** True if the command opens a separate flow (used by /help formatting). */
  opensFlow?: boolean
  /** Implementation — receives the args string after the command. */
  run: (args: string) => SlashOutcome | Promise<SlashOutcome>
}

const HELP: SlashCommand = {
  name: '/help',
  desc: 'List available slash commands.',
  run: () => ({ kind: 'message', text: renderHelp() }),
}

const QUIT: SlashCommand = {
  name: '/quit',
  desc: 'Exit the shell.',
  run: () => ({ kind: 'action', action: 'exit' }),
}

const SCAN: SlashCommand = {
  name: '/scan',
  desc: 'Scan this repository and upload a knowledge artifact. Add --add-repo to merge into an existing source.',
  opensFlow: true,
  run: (args) => ({ kind: 'action', action: 'open_scan', args }),
}

const REFINE: SlashCommand = {
  name: '/refine',
  desc: 'Edit identity overrides on the live artifact (name, description, notes).',
  opensFlow: true,
  run: () => ({ kind: 'action', action: 'open_refine' }),
}

const INSTRUMENT: SlashCommand = {
  name: '/instrument',
  desc: 'Add Holostaff SDK tracking calls and open a PR. (lands in A5)',
  run: () => ({
    kind: 'message',
    tone: 'info',
    text:
      '/instrument lands in milestone A5. The flow will: 1) run /scan, 2) generate SDK init + tracking calls, 3) show a diff, 4) branch + commit + open a PR via gh. For now use /scan.',
  }),
}

const EMBED: SlashCommand = {
  name: '/embed',
  desc: 'Add a copilot widget to the app entry point. (lands in A6)',
  run: () => ({
    kind: 'message',
    tone: 'info',
    text:
      '/embed lands in milestone A6. The flow will: 1) list your workspace\'s copilots, 2) you pick one, 3) I add the Holostaff widget to your app entry, 4) branch + commit + PR.',
  }),
}

const WHOAMI: SlashCommand = {
  name: '/whoami',
  desc: 'Show the signed-in user + workspace.',
  run: () => {
    const r = formatWhoami()
    return { kind: 'message', text: r.text, tone: r.ok ? 'info' : 'warn' }
  },
}

const WORKSPACE: SlashCommand = {
  name: '/workspace',
  desc: 'Show the active workspace.',
  run: () => {
    const r = formatWorkspace()
    return { kind: 'message', text: r.text, tone: r.ok ? 'info' : 'warn' }
  },
}

const LOGIN: SlashCommand = {
  name: '/login',
  desc: 'Re-authenticate with Holostaff.',
  opensFlow: true,
  run: () => ({ kind: 'action', action: 'reauth' }),
}

const LOGOUT: SlashCommand = {
  name: '/logout',
  desc: 'Clear local credentials.',
  run: () => {
    const removed = clearCredentials()
    return {
      kind: 'message',
      tone: 'info',
      text: removed
        ? `Logged out. Removed ${credentialsPath()}.`
        : 'Already logged out (no credentials file).',
    }
  },
}

export const SLASH_COMMANDS: SlashCommand[] = [
  HELP, SCAN, REFINE, INSTRUMENT, EMBED, WHOAMI, WORKSPACE, LOGIN, LOGOUT, QUIT,
]

function findCommand(name: string): SlashCommand | undefined {
  const target = name.toLowerCase()
  return SLASH_COMMANDS.find((c) => c.name === target)
}

/**
 * Parse + dispatch a single line. The caller has already verified that
 * `line` starts with '/'. Returns the outcome the shell should apply.
 */
export async function dispatchSlash(line: string): Promise<SlashOutcome> {
  const trimmed = line.trim()
  const space = trimmed.indexOf(' ')
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const args = space === -1 ? '' : trimmed.slice(space + 1)
  const handler = findCommand(cmd)
  if (!handler) {
    return {
      kind: 'message',
      tone: 'warn',
      text: `Unknown command: ${cmd}. Type /help to see what's available.`,
    }
  }
  return await handler.run(args)
}

function renderHelp(): string {
  const lines: string[] = ['']
  lines.push('Slash commands:')
  lines.push('')
  const padTo = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 2
  for (const c of SLASH_COMMANDS) {
    lines.push(`  ${c.name.padEnd(padTo)}${c.desc}`)
  }
  lines.push('')
  lines.push('Anything that doesn\'t start with a slash is a question — I\'ll answer.')
  return lines.join('\n')
}
