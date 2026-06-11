/**
 * Plain-text command handlers — `holostaff whoami / logout / workspace
 * / --help / --version`. These don't need a TTY: they just read or
 * mutate local state and print to stdout. CI scripts and pipes can
 * call them.
 */

import { clearCredentials, credentialsPath, resolveAuth } from '../auth/credentials.js'

const COMMAND_HELP = [
  '',
  '  Holostaff CLI',
  '',
  '  Usage:',
  '    holostaff                                         Interactive shell',
  '    holostaff login                                   Re-run device-flow auth',
  '    holostaff logout                                  Clear local credentials',
  '    holostaff whoami                                  Show signed-in account + workspace',
  '    holostaff workspace                               List workspaces',
  '    holostaff scan [--add-repo ID] [--quiet] [--json] Headless scan (CI-friendly)',
  '             [--out PATH]',
  '    holostaff deploy [--dry-run] [--force]            Open a deploy PR for the bound source',
  '    holostaff --version                               Print CLI version',
  '    holostaff --help                                  This message',
  '',
  '  Environment:',
  '    HOLOSTAFF_API_KEY             CI: bearer token to use instead of device flow',
  '    HOLOSTAFF_WORKSPACE_ID        CI: workspace to bind the API key to',
  '    HOLOSTAFF_API_BASE_URL        Override backend URL (default: prod)',
  '    AZURE_ANTHROPIC_ENDPOINT      Required by `holostaff scan` for the model API',
  '    AZURE_ANTHROPIC_API_KEY       Required by `holostaff scan` for the model API',
  '',
  '  Docs:  https://docs.holostaff.ai/cli',
  '',
].join('\n')

export function runHelp(): number {
  process.stdout.write(COMMAND_HELP)
  return 0
}

export function runVersion(version: string): number {
  process.stdout.write(`holostaff ${version}\n`)
  return 0
}

export function formatWhoami(): { ok: boolean; text: string } {
  const auth = resolveAuth()
  if (auth.source === 'none') {
    return { ok: false, text: 'Not signed in. Run `holostaff login` to connect.' }
  }
  if (auth.source === 'env') {
    return {
      ok: true,
      text: [
        `Signed in via HOLOSTAFF_API_KEY (CI mode).`,
        `Workspace: ${auth.workspaceId ?? '(not set — set HOLOSTAFF_WORKSPACE_ID)'}`,
        `Backend:   ${auth.baseUrl}`,
      ].join('\n'),
    }
  }
  if (auth.expired) {
    return { ok: false, text: 'Token expired. Run `holostaff login` to refresh.' }
  }
  return {
    ok: true,
    text: [
      `Signed in.`,
      `User:      ${auth.userId ?? '(unknown)'}`,
      `Workspace: ${auth.workspaceId ?? '(unknown)'}`,
      `Backend:   ${auth.baseUrl}`,
      `Creds:     ${credentialsPath()}`,
    ].join('\n'),
  }
}

export function runWhoami(): number {
  const r = formatWhoami()
  process.stdout.write(r.text + '\n')
  return r.ok ? 0 : 1
}

export function runLogout(): number {
  const removed = clearCredentials()
  if (removed) {
    process.stdout.write(`Logged out. Removed ${credentialsPath()}\n`)
    return 0
  }
  process.stdout.write(`Already logged out (no credentials file).\n`)
  return 0
}

/**
 * Workspace command — v1 lists what we know locally. The CLI doesn't
 * round-trip to /api/cli/workspaces here because that's another
 * network call for a piece of info we already have on disk. Switch /
 * multi-workspace lands in a follow-up; the device flow only ever
 * binds one workspace today.
 */
export function formatWorkspace(): { ok: boolean; text: string } {
  const auth = resolveAuth()
  if (auth.source === 'none') {
    return { ok: false, text: 'Not signed in. Run `holostaff login` first.' }
  }
  if (!auth.workspaceId) {
    return { ok: false, text: 'No workspace bound to current credentials.' }
  }
  return { ok: true, text: `Active workspace: ${auth.workspaceId}` }
}

export function runWorkspace(): number {
  const r = formatWorkspace()
  process.stdout.write(r.text + '\n')
  return r.ok ? 0 : 1
}

export function runUnknown(arg: string): number {
  process.stderr.write(
    `holostaff: unknown command: ${arg}\n`
    + `Run \`holostaff --help\` to see what's available.\n`,
  )
  return 64 // EX_USAGE
}
