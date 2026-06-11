/**
 * `holostaff deploy` — ported from holostaff-agent cli-extensions/deploy
 * (Wave 1d module, Wave 1f PR creation).
 *
 * Orchestrates the deploy state-machine flow from
 * copilot-deploy-design.md §6 against the server's /api/cli endpoints:
 *
 *   1. Resolve auth (CLI credentials) + source binding (.holostaff/source.json).
 *   2. Fetch source state + live artifact.
 *   3. Decide pending kind: 'live' | 'pending_scan' | 'pending_edits' | 'open_deploy'.
 *   4. If 'live': no-op exit.
 *   5. If 'open_deploy': prompt force/wait/cancel (or non-interactive with --force).
 *   6. Register intent via POST /deploys.
 *   7. Ask the server to open the PR via the Holostaff GitHub App;
 *      on failure mark the deploy 'failed' so the source isn't locked.
 *
 * Modes:
 *   - default                  the flow above
 *   - --dry-run / -n           steps 1–4 only; prints the plan; never registers
 *   - --force / -f             skip the prompt; push onto any open deploy
 */

import { resolveAuth } from '../auth/credentials.js'
import { readBinding, type SourceBinding } from '../binding/sourceBinding.js'
import {
  ApiError,
  createDeploy,
  createDeployPr,
  getArtifact,
  getOpenDeploy,
  getSource,
  setDeployState,
  type DeployRun,
  type KnowledgeSourceState,
} from './api.js'
import type { DeployAuth } from './types.js'
import { editsKeyOf } from './editsKey.js'
import { promptChoice, type PromptOption } from './prompt.js'
import { detectGithubRepoFullName } from './gitRepo.js'

export interface RunDeployOptions {
  repoRoot: string
  dryRun?: boolean
  force?: boolean
  /** Suppress all stdout. Used by tests. */
  silent?: boolean
  /**
   * Never prompt interactively — even when stdin is a TTY. Set by the
   * Ink shell's /deploy command: readline prompts would clash with
   * Ink's raw-mode input, so the open-deploy decision degrades to a
   * "re-run with --force" message instead.
   */
  nonInteractive?: boolean
}

export interface RunDeployResult {
  exitCode: 0 | 1 | 2
  kind:
    | 'live'
    | 'pending_scan'
    | 'pending_edits'
    | 'open_deploy_aborted'
    | 'pr_opened'
    | 'pr_create_failed'
    | 'no_repo'
    | 'no_auth'
    | 'no_binding'
    | 'api_error'
  deploy?: DeployRun
  source?: KnowledgeSourceState
  message?: string
  prUrl?: string
}

interface OutputSink {
  log: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

function sink(silent?: boolean): OutputSink {
  if (silent) return { log: () => {}, warn: () => {}, error: () => {} }
  return {
    log: (msg) => process.stdout.write(`${msg}\n`),
    warn: (msg) => process.stdout.write(`${msg}\n`),
    error: (msg) => process.stderr.write(`${msg}\n`),
  }
}

// -------------------------------------------------------------------------
// Public entry
// -------------------------------------------------------------------------

export async function runDeploy(opts: RunDeployOptions): Promise<RunDeployResult> {
  const out = sink(opts.silent)

  // 1. Auth — CLI credentials (env key or device-flow file).
  const resolved = resolveAuth()
  if (resolved.source === 'none' || !resolved.token) {
    out.error('No active credentials. Run `holostaff login` or set HOLOSTAFF_API_KEY.')
    return { exitCode: 1, kind: 'no_auth' }
  }
  if (resolved.expired) {
    out.error('Token expired. Run `holostaff login` to refresh.')
    return { exitCode: 1, kind: 'no_auth' }
  }
  const auth: DeployAuth = {
    token: resolved.token,
    baseUrl: resolved.baseUrl,
    workspaceId: resolved.workspaceId,
  }

  // 2. Binding — per-repo .holostaff/source.json.
  const bindRes = readBinding(opts.repoRoot, resolved.workspaceId ?? '')
  if (bindRes.kind !== 'found') {
    if (bindRes.kind === 'missing') {
      out.error(`No source binding at ${opts.repoRoot}/.holostaff/source.json. Run \`holostaff scan\` first.`)
    } else if (bindRes.kind === 'wrong_workspace') {
      out.error(
        `Binding points at workspace ${bindRes.binding.workspaceId} but you're logged into ${bindRes.expectedWorkspaceId}. `
        + `Switch workspaces or rescan in this one.`,
      )
    } else {
      out.error(`Source binding is malformed: ${bindRes.error}`)
    }
    return { exitCode: 1, kind: 'no_binding' }
  }
  const binding = bindRes.binding

  // 3. Fetch state + run.
  try {
    return await runWithBinding(auth, binding, opts, out)
  } catch (err) {
    if (err instanceof ApiError) {
      out.error(`API error (${err.status}): ${err.message}`)
      return { exitCode: 1, kind: 'api_error', message: err.message }
    }
    out.error(`Unexpected error: ${(err as Error).message}`)
    return { exitCode: 1, kind: 'api_error', message: (err as Error).message }
  }
}

// -------------------------------------------------------------------------
// Implementation
// -------------------------------------------------------------------------

async function runWithBinding(
  auth: DeployAuth,
  binding: SourceBinding,
  opts: RunDeployOptions,
  out: OutputSink,
): Promise<RunDeployResult> {
  out.log(`→ Reading source state for ${binding.name} (${binding.sourceId})...`)
  const source = await getSource(auth, binding.sourceId)

  if (!source.liveArtifactVersion) {
    out.error('Source has no live artifact yet. Run `holostaff scan` first.')
    return { exitCode: 1, kind: 'pending_scan', source }
  }

  const artifact = await getArtifact(auth, binding.sourceId, source.liveArtifactVersion)
  const currentEditsKey = editsKeyOf(artifact.customerEdits)
  const liveVersion = source.liveArtifactVersion
  const deployedVersion = source.lastDeployedVersion
  const deployedKey = source.lastDeployedEditsKey

  // 4. Already-deployed check
  if (
    deployedVersion === liveVersion
    && deployedKey === currentEditsKey
    && !source.openDeployId
  ) {
    out.log(`→ v${liveVersion} is already deployed. Nothing to do.`)
    return { exitCode: 0, kind: 'live', source }
  }

  // 5. Open-deploy guard
  if (source.openDeployId) {
    const openDeploy = await getOpenDeploy(auth, binding.sourceId)
    if (openDeploy) {
      out.log(
        `→ Open deploy: ${openDeploy.id} by ${openDeploy.triggeredBy}, `
        + `v${openDeploy.artifactVersion}, opened ${humanAgo(openDeploy.triggeredAt)}.`,
      )
      if (openDeploy.pr) {
        out.log(`  PR: ${openDeploy.pr.url}`)
      }
      const decision = await decideOpenDeploy(opts, out)
      if (decision === 'wait' || decision === 'cancel') {
        return { exitCode: decision === 'cancel' ? 2 : 0, kind: 'open_deploy_aborted', source, deploy: openDeploy }
      }
      // decision === 'force' — fall through to the create flow.
    }
  }

  // Plan summary
  out.log('')
  out.log('Plan:')
  out.log(`  source:           ${binding.name} (${binding.sourceId})`)
  out.log(`  live artifact:    v${liveVersion}`)
  out.log(`  last deployed:    ${deployedVersion ? `v${deployedVersion}` : '(never)'}`)
  out.log(`  edits drift:      ${deployedKey === currentEditsKey ? 'none' : 'yes'}`)
  out.log(`  intent:           ${source.openDeployId ? 'force-push onto open deploy' : 'open new deploy'}`)
  out.log('')

  if (opts.dryRun) {
    out.log('Dry run — no deploy registered. Re-run without --dry-run to proceed.')
    const kind: RunDeployResult['kind'] =
      liveVersion !== deployedVersion ? 'pending_scan' : 'pending_edits'
    return { exitCode: 0, kind, source }
  }

  // 6. Resolve target repo from git origin.
  const repoFullName = detectGithubRepoFullName(opts.repoRoot)
  if (!repoFullName) {
    out.error('Could not detect a GitHub origin remote in this repo.')
    out.error('Add one with `git remote add origin git@github.com:owner/repo.git` and try again.')
    return { exitCode: 1, kind: 'no_repo', source }
  }
  out.log(`→ Target repo: ${repoFullName}`)

  // 7. Register deploy intent
  out.log('→ Registering deploy intent...')
  const { deploy, repushed } = await createDeploy(
    auth,
    binding.sourceId,
    liveVersion,
    { force: opts.force || Boolean(source.openDeployId) },
  )
  out.log(`  ✓ ${repushed ? 'Repushed onto' : 'Created'} deploy ${deploy.id}`)

  // 8. Server opens the PR via the Holostaff GitHub App.
  out.log('→ Creating PR via Holostaff GitHub App...')
  try {
    const result = await createDeployPr(auth, binding.sourceId, deploy.id, repoFullName)
    out.log(`  ✓ PR #${result.pr.number}: ${result.pr.url}`)
    out.log(`  ✓ Installed on: ${result.installation.accountLogin}`)
    out.log('')
    out.log(`Deploy ${deploy.id} state: pr_open.`)
    out.log('Merge the PR to make this version live. The dashboard pill flips on the merge webhook.')
    return {
      exitCode: 0,
      kind: 'pr_opened',
      source,
      deploy: { ...deploy, state: 'pr_open' },
      prUrl: result.pr.url,
    }
  } catch (err) {
    // Surface a helpful failure + release the lock so the source isn't
    // stuck. The user can retry once they fix the underlying cause.
    let reason = 'pr-create-failed'
    if (err instanceof ApiError) {
      if (err.status === 503) reason = 'github-app-not-configured'
      else if (err.status === 412) reason = 'no-installation-for-repo'
      out.error(`PR creation failed (${err.status}): ${err.message}`)
      if (err.status === 503) {
        out.error('  → Server admin: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET.')
      } else if (err.status === 412) {
        out.error(`  → Install the Holostaff GitHub App on the org that owns ${repoFullName}.`)
        out.error('  → Visit /integrations/github on the dashboard for the install link.')
      }
    } else {
      out.error(`PR creation failed: ${(err as Error).message}`)
    }
    const failed = await setDeployState(
      auth,
      binding.sourceId,
      deploy.id,
      'failed',
      { failureReason: reason },
    ).catch(() => null)
    return {
      exitCode: 1,
      kind: 'pr_create_failed',
      source,
      deploy: failed ?? deploy,
      message: (err as Error).message,
    }
  }
}

async function decideOpenDeploy(
  opts: RunDeployOptions,
  out: OutputSink,
): Promise<'force' | 'wait' | 'cancel'> {
  if (opts.force) return 'force'
  if (opts.nonInteractive || !process.stdin.isTTY) {
    out.error('An open deploy exists. Re-run with --force to push onto it, or wait for it to merge.')
    return 'cancel'
  }
  const options: Array<PromptOption<'force' | 'wait' | 'cancel'>> = [
    { key: '1', value: 'force', label: 'Push your changes onto the open PR (force)' },
    { key: '2', value: 'wait',  label: 'Wait — exit and re-run after it merges' },
    { key: '3', value: 'cancel', label: 'Cancel' },
  ]
  const choice = await promptChoice('How do you want to proceed?', options)
  return choice ?? 'cancel'
}

function humanAgo(iso: string): string {
  const now = Date.now()
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const diffMs = Math.max(0, now - then)
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}
