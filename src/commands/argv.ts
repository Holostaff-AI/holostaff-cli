/**
 * Tiny argv parser. The CLI's command surface is small enough that
 * pulling in commander/yargs would be more code than the parsing
 * itself. We keep it here so tests can exercise it directly.
 *
 * Supported invocations:
 *   holostaff                           interactive (default)
 *   holostaff login                     re-run auth, even if creds exist
 *   holostaff logout                    clear local credentials
 *   holostaff whoami                    print account + workspace
 *   holostaff workspace                 list workspaces
 *   holostaff --version                 print version + exit
 *   holostaff -v
 *   holostaff --help                    print command list + exit
 *   holostaff -h
 *   holostaff help
 */

export type ParsedArgs =
  | { kind: 'interactive' }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'whoami' }
  | { kind: 'workspace' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'unknown'; arg: string }

export function parseArgs(argv: string[]): ParsedArgs {
  // argv begins after `node holostaff` — what we get is the actual
  // user-supplied args.
  if (argv.length === 0) return { kind: 'interactive' }
  const a = argv[0]!
  if (a === '--version' || a === '-v') return { kind: 'version' }
  if (a === '--help' || a === '-h' || a === 'help') return { kind: 'help' }
  if (a === 'login') return { kind: 'login' }
  if (a === 'logout') return { kind: 'logout' }
  if (a === 'whoami') return { kind: 'whoami' }
  if (a === 'workspace') return { kind: 'workspace' }
  return { kind: 'unknown', arg: a }
}
