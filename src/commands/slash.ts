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
import { runDeploy, type RunDeployResult } from '../deploy/index.js'

export type SlashOutcome =
  | { kind: 'message'; text: string; tone?: 'info' | 'warn' | 'error' | 'success' }
  | {
      kind: 'action'
      action:
        | 'open_scan'
        | 'open_refine'
        | 'open_instrument'
        | 'open_embed'
        | 'exit'
        | 'reauth'
      args?: string
    }

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
  desc: 'Generate Holostaff SDK init + tracking, write to a feature branch.',
  opensFlow: true,
  run: () => ({ kind: 'action', action: 'open_instrument' }),
}

const EMBED: SlashCommand = {
  name: '/embed',
  desc: 'Add the Holostaff widget script to your app entry, write to a feature branch.',
  opensFlow: true,
  run: () => ({ kind: 'action', action: 'open_embed' }),
}

const DEPLOY: SlashCommand = {
  name: '/deploy',
  desc: 'Open a deploy PR for the bound source. Flags: --dry-run, --force.',
  run: async (args) => {
    const dryRun = /(^|\s)(--dry-run|-n)(\s|$)/.test(args)
    const force = /(^|\s)(--force|-f)(\s|$)/.test(args)
    // silent: the structured result drives the message; nonInteractive:
    // readline prompts would clash with Ink's raw-mode stdin.
    const result = await runDeploy({
      repoRoot: process.cwd(),
      dryRun,
      force,
      silent: true,
      nonInteractive: true,
    })
    return formatDeployOutcome(result, dryRun)
  },
}

function formatDeployOutcome(r: RunDeployResult, dryRun: boolean): SlashOutcome {
  switch (r.kind) {
    case 'pr_opened':
      return {
        kind: 'message', tone: 'success',
        text: [
          `Deploy ${r.deploy?.id ?? ''} → PR opened:`,
          `  ${r.prUrl}`,
          '',
          'Merge the PR to make this version live. The dashboard pill flips on the merge webhook.',
        ].join('\n'),
      }
    case 'live':
      return {
        kind: 'message', tone: 'info',
        text: `v${r.source?.liveArtifactVersion} is already deployed. Nothing to do.`,
      }
    case 'pending_scan':
      return dryRun && r.source?.liveArtifactVersion
        ? { kind: 'message', tone: 'info', text: `Dry run — would open a deploy PR for v${r.source.liveArtifactVersion}. Run /deploy to proceed.` }
        : { kind: 'message', tone: 'warn', text: 'Source has no live artifact yet. Run /scan first.' }
    case 'pending_edits':
      return { kind: 'message', tone: 'info', text: `Dry run — canvas edits drifted since the last deploy. Run /deploy to ship them.` }
    case 'open_deploy_aborted':
      return {
        kind: 'message', tone: 'warn',
        text: [
          `An open deploy already exists${r.deploy?.pr ? ` (PR: ${r.deploy.pr.url})` : ''}.`,
          'Run `/deploy --force` to push onto it, or merge/close the PR first.',
        ].join('\n'),
      }
    case 'no_auth':
      return { kind: 'message', tone: 'error', text: 'Not signed in (or token expired). Run /login first.' }
    case 'no_binding':
      return { kind: 'message', tone: 'error', text: 'No source binding in this repo. Run /scan first.' }
    case 'no_repo':
      return { kind: 'message', tone: 'error', text: 'Could not detect a GitHub origin remote in this repo.' }
    case 'pr_create_failed':
      return {
        kind: 'message', tone: 'error',
        text: [
          `PR creation failed: ${r.message ?? 'unknown error'}`,
          'The deploy was marked failed so the source is not locked. Fix the cause and re-run /deploy.',
        ].join('\n'),
      }
    default:
      return { kind: 'message', tone: 'error', text: `Deploy failed: ${r.message ?? r.kind}` }
  }
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
  HELP, SCAN, DEPLOY, REFINE, INSTRUMENT, EMBED, WHOAMI, WORKSPACE, LOGIN, LOGOUT, QUIT,
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
