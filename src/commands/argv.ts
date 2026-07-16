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
 *   holostaff scan [--add-repo <id>] [--quiet] [--json] [--out PATH]
 *                                       headless scan; CI-friendly
 *   holostaff --version                 print version + exit
 *   holostaff -v
 *   holostaff --help                    print command list + exit
 *   holostaff -h
 *   holostaff help
 */

export interface ScanArgs {
  /** Suppress all stderr progress; emit only the final result. */
  quiet: boolean
  /** Emit the result as a single JSON object to stdout (or --out path). */
  json: boolean
  /** Optional file to write the JSON result to instead of stdout. */
  out?: string
  /** Existing source id to merge into; switches to mergeMode='append'. */
  addRepo?: string
}

export interface DeployArgs {
  /** Print the plan; never register or modify state. */
  dryRun: boolean
  /** Skip the open-deploy prompt; push onto any open deploy. */
  force: boolean
}

export interface EmbedArgs {
  /** Copilot to wire the widget snippet to. */
  copilotId: string
  /** Suppress all stderr progress; emit only the final result. */
  quiet: boolean
  /** Emit the result as a single JSON object to stdout (or --out path). */
  json: boolean
  /** Optional file to write the JSON result to instead of stdout. */
  out?: string
  /** Commit the branch but skip pushing / opening a PR. */
  noPr: boolean
}

export type ParsedArgs =
  | { kind: 'interactive' }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'whoami' }
  | { kind: 'workspace' }
  | { kind: 'scan'; opts: ScanArgs }
  | { kind: 'deploy'; opts: DeployArgs }
  | { kind: 'embed'; opts: EmbedArgs }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'unknown'; arg: string }
  | { kind: 'bad_args'; reason: string }

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { kind: 'interactive' }
  const a = argv[0]!
  if (a === '--version' || a === '-v') return { kind: 'version' }
  if (a === '--help' || a === '-h' || a === 'help') return { kind: 'help' }
  if (a === 'login') return { kind: 'login' }
  if (a === 'logout') return { kind: 'logout' }
  if (a === 'whoami') return { kind: 'whoami' }
  if (a === 'workspace') return { kind: 'workspace' }
  if (a === 'scan') return parseScan(argv.slice(1))
  if (a === 'deploy') return parseDeploy(argv.slice(1))
  if (a === 'embed') return parseEmbed(argv.slice(1))
  return { kind: 'unknown', arg: a }
}

function parseEmbed(rest: string[]): ParsedArgs {
  const opts: EmbedArgs = { copilotId: '', quiet: false, json: false, noPr: false }
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!
    if (tok === '--quiet') { opts.quiet = true; continue }
    if (tok === '--json') { opts.json = true; continue }
    if (tok === '--no-pr') { opts.noPr = true; continue }
    if (tok === '--out') {
      const v = rest[++i]
      if (!v) return { kind: 'bad_args', reason: '--out requires a path argument' }
      opts.out = v
      continue
    }
    if (tok.startsWith('--out=')) {
      opts.out = tok.slice('--out='.length)
      if (!opts.out) return { kind: 'bad_args', reason: '--out requires a path argument' }
      continue
    }
    if (tok.startsWith('--')) return { kind: 'bad_args', reason: `unknown embed flag: ${tok}` }
    if (opts.copilotId) return { kind: 'bad_args', reason: `embed takes a single copilotId (got extra: ${tok})` }
    opts.copilotId = tok
  }
  if (!opts.copilotId) return { kind: 'bad_args', reason: 'embed requires a copilotId argument (find yours at holostaff.ai/copilots, or run /embed interactively)' }
  if (opts.out && !opts.json) opts.json = true
  return { kind: 'embed', opts }
}

function parseDeploy(rest: string[]): ParsedArgs {
  const opts: DeployArgs = { dryRun: false, force: false }
  for (const tok of rest) {
    if (tok === '--dry-run' || tok === '-n') { opts.dryRun = true; continue }
    if (tok === '--force' || tok === '-f') { opts.force = true; continue }
    return { kind: 'bad_args', reason: `unknown deploy flag: ${tok}` }
  }
  return { kind: 'deploy', opts }
}

function parseScan(rest: string[]): ParsedArgs {
  const opts: ScanArgs = { quiet: false, json: false }
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!
    if (tok === '--quiet') { opts.quiet = true; continue }
    if (tok === '--json') { opts.json = true; continue }
    if (tok === '--out') {
      const v = rest[++i]
      if (!v) return { kind: 'bad_args', reason: '--out requires a path argument' }
      opts.out = v
      continue
    }
    if (tok.startsWith('--out=')) {
      opts.out = tok.slice('--out='.length)
      if (!opts.out) return { kind: 'bad_args', reason: '--out requires a path argument' }
      continue
    }
    if (tok === '--add-repo') {
      const v = rest[++i]
      if (!v) return { kind: 'bad_args', reason: '--add-repo requires a sourceId argument' }
      opts.addRepo = v
      continue
    }
    if (tok.startsWith('--add-repo=')) {
      opts.addRepo = tok.slice('--add-repo='.length)
      if (!opts.addRepo) return { kind: 'bad_args', reason: '--add-repo requires a sourceId argument' }
      continue
    }
    return { kind: 'bad_args', reason: `unknown scan flag: ${tok}` }
  }
  // --out implies --json (no point writing prose to a file).
  if (opts.out && !opts.json) opts.json = true
  return { kind: 'scan', opts }
}
