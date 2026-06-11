/**
 * Typed fetch wrappers for the Wave 1b deploy endpoints
 * (server/src/bowtie/cli/cliApi.ts).
 *
 * Endpoints:
 *   GET    /api/cli/sources/:sid                   (existing)
 *   GET    /api/cli/sources/:sid/artifacts/:ver    (existing)
 *   GET    /api/cli/sources/:sid/deploys/open
 *   GET    /api/cli/sources/:sid/deploys
 *   POST   /api/cli/sources/:sid/deploys
 *   GET    /api/cli/sources/:sid/deploys/:deployId
 *   PATCH  /api/cli/sources/:sid/deploys/:deployId
 *
 * All calls authenticate with the resolved bearer token.
 *
 * The types here mirror server schemas loosely (Wave 1d ships the CLI
 * sub-wave; bringing in zod or the server's full type tree would
 * couple the CLI to server internals). When ported into the CLI repo
 * the types can be tightened against shared zod schemas.
 */

import type { DeployAuth } from './types.js'

// ---------- Server types (loose) ----------

export interface KnowledgeSourceState {
  id: string
  tenantId: string
  name: string
  liveArtifactVersion: number | null
  latestArtifactVersion: number | null
  lastDeployedVersion: number | null
  lastDeployedEditsKey: string | null
  lastDeployedAt: string | null
  openDeployId: string | null
}

export interface KnowledgeArtifactState {
  id: string
  version: number
  customerEdits?: Record<string, unknown>
  stageCopilots?: Record<string, string | null>
}

export interface DeployPr {
  url: string
  number: number
  branch: string
  forge: 'github'
}

export interface DeployRun {
  id: string
  tenantId: string
  sourceId: string
  artifactVersion: number
  editsKey: string
  triggeredBy: string
  triggeredAt: string
  state: 'pr_opening' | 'pr_open' | 'merged' | 'closed_unmerged' | 'failed'
  pr: DeployPr | null
  repushedBy: Array<{ by: string; at: string; artifactVersion: number }>
  failureReason?: string
  mergedAt?: string
  closedAt?: string
}

// ---------- HTTP helper ----------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function call<T>(
  auth: DeployAuth,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${auth.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'authorization': `Bearer ${auth.token}`,
      'content-type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'error' in body)
      ? String((body as { error: unknown }).error)
      : `${res.status} ${res.statusText}`
    throw new ApiError(res.status, message, body)
  }
  return body as T
}

// ---------- Endpoints ----------

export async function getSource(
  auth: DeployAuth,
  sourceId: string,
): Promise<KnowledgeSourceState> {
  const res = await call<{ source: KnowledgeSourceState }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}`,
  )
  return res.source
}

export async function getArtifact(
  auth: DeployAuth,
  sourceId: string,
  version: number,
): Promise<KnowledgeArtifactState> {
  const res = await call<{ artifact: KnowledgeArtifactState }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/artifacts/${version}`,
  )
  return res.artifact
}

export async function getOpenDeploy(
  auth: DeployAuth,
  sourceId: string,
): Promise<DeployRun | null> {
  const res = await call<{ deploy: DeployRun | null }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys/open`,
  )
  return res.deploy
}

export async function listDeploys(
  auth: DeployAuth,
  sourceId: string,
): Promise<DeployRun[]> {
  const res = await call<{ deploys: DeployRun[] }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys`,
  )
  return res.deploys
}

/**
 * Register a new deploy. If another deploy is open the server returns
 * 409; the caller can retry with `force: true` to repush onto it.
 */
export async function createDeploy(
  auth: DeployAuth,
  sourceId: string,
  artifactVersion: number,
  options: { force?: boolean } = {},
): Promise<{ deploy: DeployRun; repushed: boolean }> {
  const body = { artifactVersion, force: options.force ?? false }
  const res = await call<{ deploy: DeployRun; repushed?: boolean }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys`,
    { method: 'POST', body },
  )
  return { deploy: res.deploy, repushed: Boolean(res.repushed) }
}

export async function attachPr(
  auth: DeployAuth,
  sourceId: string,
  deployId: string,
  pr: DeployPr,
): Promise<DeployRun> {
  const res = await call<{ deploy: DeployRun }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys/${encodeURIComponent(deployId)}`,
    { method: 'PATCH', body: { pr } },
  )
  return res.deploy
}

export async function setDeployState(
  auth: DeployAuth,
  sourceId: string,
  deployId: string,
  state: 'merged' | 'closed_unmerged' | 'failed',
  options: { failureReason?: string } = {},
): Promise<DeployRun> {
  const res = await call<{ deploy: DeployRun }>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys/${encodeURIComponent(deployId)}`,
    { method: 'PATCH', body: { state, failureReason: options.failureReason } },
  )
  return res.deploy
}

/**
 * Wave 1f: ask the server to create the deploy PR via the GitHub App.
 * Server returns the PR url + number once the branch is pushed + PR
 * opened. The server-side handler is at
 * /api/cli/sources/:sid/deploys/:deployId/create-pr (cliApi.ts).
 *
 * Throws ApiError with helpful status codes:
 *   - 503: GitHub App not configured (set GITHUB_APP_* env vars)
 *   - 412: no installation owns the target repo for this tenant
 *   - 502: GitHub REST call failed (rate limit, perms, etc.)
 */
export interface CreatePrResponse {
  pr: DeployPr
  installation: { id: number; accountLogin: string }
}

export async function createDeployPr(
  auth: DeployAuth,
  sourceId: string,
  deployId: string,
  repoFullName: string,
): Promise<CreatePrResponse> {
  return await call<CreatePrResponse>(
    auth,
    `/api/cli/sources/${encodeURIComponent(sourceId)}/deploys/${encodeURIComponent(deployId)}/create-pr`,
    { method: 'POST', body: { repoFullName } },
  )
}
