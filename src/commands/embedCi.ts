/**
 * runEmbedCi — headless embed for CI / the deployment test rig.
 *
 * Composes the same pieces the interactive /embed flow drives through
 * Ink: runEmbed (agent drafts the plan) → applyPlan (branch + commit)
 * → openPullRequest (gh push + PR) → setEmbedState (dashboard status).
 * No review prompt — scripted callers have already decided; the branch
 * and PR are themselves the review surface.
 *
 * Exit codes (mirrors scanCi):
 *   0  committed (and PR opened, unless --no-pr)
 *   1  agent / apply / PR error
 *   2  preflight failure (no binding, env missing)
 *   3  auth not configured
 */

import { writeFileSync } from 'node:fs'
import type { EmbedArgs } from './argv.js'
import { resolveAuth } from '../auth/credentials.js'
import { readBinding } from '../binding/sourceBinding.js'
import { runEmbed, type EmbedEvent } from '../agent/embed/runEmbed.js'
import { buildAgentEnv } from '../agent/runScan.js'
import { applyPlan } from '../instrument/applyPlan.js'
import { openPullRequest, type PrResult } from '../instrument/openPullRequest.js'
import { listCopilots, setEmbedState } from '../auth/api.js'
import { emit as emitTelemetry, classifyError } from '../telemetry.js'

export interface CiEmbedResult {
  ok: boolean
  phase?: 'auth' | 'binding' | 'copilot' | 'env' | 'agent' | 'apply' | 'pr'
  error?: string

  copilot?: { id: string; name: string }
  agent?: { durationMs: number; sessionId: string | undefined; tokens: { input: number; output: number } }
  commit?: { branch: string; sha: string; filesChanged: string[]; packagesToInstall: string[]; packageManager?: string }
  pr?: PrResult
}

export async function runEmbedCi(opts: EmbedArgs, cwd: string): Promise<number> {
  const log = opts.quiet ? () => { /* suppressed */ } : (line: string) => process.stderr.write(line + '\n')
  const t0 = Date.now()
  const fail = (result: CiEmbedResult, code: number, errorKind?: string): number => {
    emitTelemetry({
      command: 'embed_ci',
      outcome: 'error',
      errorKind: errorKind ?? classifyError(result.error ?? ''),
      durationMs: Date.now() - t0,
    })
    return emitOutput(opts, result, code)
  }

  // 1. Auth — env key (CI) or local credentials, same policy as scanCi.
  const auth = resolveAuth()
  if (auth.source === 'none' || !auth.token || !auth.workspaceId) {
    return fail({
      ok: false,
      phase: 'auth',
      error: 'Not signed in. Set HOLOSTAFF_API_KEY (and HOLOSTAFF_WORKSPACE_ID) for CI mode, or run `holostaff login`.',
    }, 3, 'auth_missing')
  }
  if (auth.source === 'file' && auth.expired) {
    return fail({ ok: false, phase: 'auth', error: 'Token expired. Run `holostaff login` to refresh.' }, 3, 'auth_expired')
  }

  // 2. Source binding — embed only makes sense after a scan bound this repo.
  const read = readBinding(cwd, auth.workspaceId)
  if (read.kind !== 'found') {
    return fail({
      ok: false,
      phase: 'binding',
      error:
        read.kind === 'missing'
          ? 'No knowledge source bound to this repo. Run `holostaff scan` first.'
          : read.kind === 'wrong_workspace'
            ? `This repo's source belongs to a different workspace (${read.binding.workspaceId}).`
            : `Source binding is malformed: ${read.error}. Re-run scan to recreate.`,
    }, 2, 'binding_missing')
  }
  const sourceId = read.binding.sourceId

  // 3. Resolve the copilot — validates the id and gets the display name
  // for the PR title, exactly what the interactive picker provides.
  let copilotName = ''
  try {
    const { copilots } = await listCopilots(auth.baseUrl, auth.token)
    const match = copilots.find((c) => c.id === opts.copilotId)
    if (!match) {
      return fail({
        ok: false,
        phase: 'copilot',
        error: `Copilot ${opts.copilotId} not found in workspace ${auth.workspaceId}. Known: ${copilots.map((c) => c.id).join(', ') || '(none)'}`,
      }, 2, 'copilot_not_found')
    }
    copilotName = match.name
  } catch (err) {
    return fail({ ok: false, phase: 'copilot', error: `Failed to list copilots: ${(err as Error).message}` }, 1)
  }
  log(`· embedding copilot ${copilotName} (${opts.copilotId}) into ${cwd}`)

  // 4. Agent drafts the plan.
  const env = await buildAgentEnv()
  if (!env) {
    return fail({
      ok: false,
      phase: 'env',
      error: 'Couldn\'t resolve model credentials. CI mode mints them from /api/cli/model-session via HOLOSTAFF_API_KEY; or set AZURE_ANTHROPIC_ENDPOINT + AZURE_ANTHROPIC_API_KEY.',
    }, 2, 'env_missing')
  }

  let lastTool = ''
  const agentResult = await runEmbed({
    cwd,
    onEvent: (ev: EmbedEvent) => {
      if (ev.type === 'tool_use' && ev.tool !== lastTool) {
        log(`· tool ${ev.tool}`)
        lastTool = ev.tool
      }
    },
  })
  if (!agentResult.ok) {
    return fail({
      ok: false,
      phase: 'agent',
      error: `embed agent failed (${agentResult.reason}): ${agentResult.error}`,
    }, 1, `agent_${agentResult.reason}`)
  }
  log(`· plan drafted in ${agentResult.durationMs}ms (${agentResult.plan.ops.length} ops)`)

  const base: CiEmbedResult = {
    ok: false,
    copilot: { id: opts.copilotId, name: copilotName },
    agent: {
      durationMs: agentResult.durationMs,
      sessionId: agentResult.sessionId,
      tokens: agentResult.tokens,
    },
  }

  // 5. Apply — branch + commit (requires a clean tree, same as interactive).
  const applied = await applyPlan({
    cwd,
    plan: agentResult.plan,
    workspaceId: auth.workspaceId,
    sourceId,
    copilotId: opts.copilotId,
    onEvent: (ev) => {
      if (ev.type === 'branch_created') log(`· branch ${ev.name}`)
      if (ev.type === 'committed') log(`✓ committed ${ev.sha.slice(0, 7)}`)
      if (ev.type === 'tree_dirty') log(`✗ working tree dirty:\n${ev.details}`)
    },
  })
  if (!applied.ok) {
    return fail({ ...base, phase: 'apply', error: `apply failed (${applied.step}): ${applied.error}` }, 1, `apply_${applied.step}`)
  }
  base.commit = {
    branch: applied.branch,
    sha: applied.sha,
    filesChanged: applied.filesChanged,
    packagesToInstall: applied.packagesToInstall,
    packageManager: applied.packageManager,
  }

  // 6. PR (unless --no-pr). A skipped/failed push is a hard failure in
  // CI — the whole point of the scripted flow is an open PR.
  if (!opts.noPr) {
    const pr = await openPullRequest({
      cwd,
      branch: applied.branch,
      title: `chore(holostaff): embed copilot${copilotName ? ` ${copilotName}` : ''}`,
      body: composeCiPrBody(base, copilotName, opts.copilotId),
    })
    base.pr = pr
    if (pr.kind !== 'opened') {
      const detail = pr.kind === 'skipped' ? `skipped: ${pr.reason}` : `${pr.step} failed: ${pr.error}`
      return fail({
        ...base,
        phase: 'pr',
        error: `branch ${applied.branch} is committed, but the PR was not opened (${detail}).`,
      }, 1, 'pr_not_opened')
    }
    log(`✓ PR ${pr.url}`)

    // Best-effort dashboard tracking, same as interactive.
    try {
      await setEmbedState(auth.baseUrl, auth.token, {
        copilotId: opts.copilotId,
        sourceId,
        phase: 'pr_open',
        prUrl: pr.url,
        prState: 'open',
      })
    } catch {
      // Never fail the flow on a tracking write.
    }
  }

  base.ok = true
  emitTelemetry({ command: 'embed_ci', outcome: 'success', durationMs: Date.now() - t0 })
  return emitOutput(opts, base, 0)
}

function composeCiPrBody(result: CiEmbedResult, copilotName: string, copilotId: string): string {
  const files = result.commit?.filesChanged ?? []
  const pkgs = result.commit?.packagesToInstall ?? []
  return [
    'Generated by `holostaff embed` (headless).',
    '',
    `Wires the Holostaff widget for **${copilotName || copilotId}** into this app.`,
    'Visitors will see this copilot once the branch merges and the build deploys.',
    '',
    `**Files changed (${files.length}):**`,
    ...files.map((f) => `- \`${f}\``),
    ...(pkgs.length ? ['', `**Install before building:** ${pkgs.map((p) => `\`${p}\``).join(', ')}`] : []),
  ].join('\n')
}

function emitOutput(opts: EmbedArgs, result: CiEmbedResult, exitCode: number): number {
  if (!result.ok && result.error) {
    // Always surface the error on stderr regardless of --quiet.
    process.stderr.write(`✗ ${result.error}\n`)
  }
  if (opts.json) {
    const json = JSON.stringify(result, null, 2)
    if (opts.out) writeFileSync(opts.out, json + '\n', { encoding: 'utf8' })
    else process.stdout.write(json + '\n')
  } else if (result.ok && result.pr?.kind === 'opened') {
    process.stdout.write(`${result.pr.url}\n`)
  } else if (result.ok && result.commit) {
    process.stdout.write(`${result.commit.branch}\n`)
  }
  return exitCode
}
