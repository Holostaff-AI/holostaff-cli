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
  '    holostaff                     Interactive shell (welcome, menu, scan, etc.)',
  '    holostaff login               Re-run the device-flow auth (overwrites creds)',
  '    holostaff logout              Clear local credentials',
  '    holostaff whoami              Show signed-in account + workspace',
  '    holostaff workspace           List workspaces',
  '    holostaff --version           Print CLI version',
  '    holostaff --help              This message',
  '',
  '  Environment:',
  '    HOLOSTAFF_API_KEY             CI: bearer token to use instead of device flow',
  '    HOLOSTAFF_WORKSPACE_ID        CI: workspace to bind the API key to',
  '    HOLOSTAFF_API_BASE_URL        Override backend URL (default: prod)',
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

export function runWhoami(): number {
  const auth = resolveAuth()
  if (auth.source === 'none') {
    process.stdout.write('Not signed in. Run `holostaff login` to connect.\n')
    return 1
  }
  if (auth.source === 'env') {
    process.stdout.write(`Signed in via HOLOSTAFF_API_KEY (CI mode).\n`)
    process.stdout.write(`Workspace: ${auth.workspaceId ?? '(not set — set HOLOSTAFF_WORKSPACE_ID)'}\n`)
    process.stdout.write(`Backend:   ${auth.baseUrl}\n`)
    return 0
  }
  // File-backed
  if (auth.expired) {
    process.stdout.write(`Token expired. Run \`holostaff login\` to refresh.\n`)
    return 1
  }
  process.stdout.write(`Signed in.\n`)
  process.stdout.write(`User:      ${auth.userId ?? '(unknown)'}\n`)
  process.stdout.write(`Workspace: ${auth.workspaceId ?? '(unknown)'}\n`)
  process.stdout.write(`Backend:   ${auth.baseUrl}\n`)
  process.stdout.write(`Creds:     ${credentialsPath()}\n`)
  return 0
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
export function runWorkspace(): number {
  const auth = resolveAuth()
  if (auth.source === 'none') {
    process.stdout.write('Not signed in. Run `holostaff login` first.\n')
    return 1
  }
  if (!auth.workspaceId) {
    process.stdout.write('No workspace bound to current credentials.\n')
    return 1
  }
  process.stdout.write(`Active workspace: ${auth.workspaceId}\n`)
  return 0
}

export function runUnknown(arg: string): number {
  process.stderr.write(
    `holostaff: unknown command: ${arg}\n`
    + `Run \`holostaff --help\` to see what's available.\n`,
  )
  return 64 // EX_USAGE
}
