/**
 * Thin HTTP client for /api/cli/* endpoints. Uses Node's native fetch
 * (Node 20+); no axios. Centralised here so retries, error mapping,
 * and the bearer-token convention live in one place.
 */

export interface StartResponse {
  state: string
  code: string
  verificationUri: string
  expiresAt: string
  pollIntervalSec: number
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'approved'; accessToken: string; userId: string; workspaceId: string; expiresAt: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'unknown' }

export interface WorkspacesResponse {
  workspaces: Array<{ id: string; name: string; isDefault?: boolean }>
  currentWorkspaceId: string
}

export interface ApiError extends Error {
  status: number
  body: unknown
}

function isApiError(err: unknown): err is ApiError {
  return !!err && typeof err === 'object' && 'status' in err && 'body' in err
}

function makeApiError(status: number, body: unknown, msg: string): ApiError {
  const e = new Error(msg) as ApiError
  e.status = status
  e.body = body
  return e
}

async function request<T>(
  baseUrl: string,
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (init.bearer) headers['Authorization'] = `Bearer ${init.bearer}`

  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers })
  } catch (err) {
    throw new Error(`network error: ${(err as Error).message}`)
  }

  const text = await res.text()
  let body: unknown = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { error: text } }

  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`
    throw makeApiError(res.status, body, msg)
  }
  return body as T
}

// -------------------------------------------------------------------------
// Endpoints
// -------------------------------------------------------------------------

export async function startDeviceFlow(baseUrl: string): Promise<StartResponse> {
  return request<StartResponse>(baseUrl, '/api/cli/auth/start', {
    method: 'POST',
    body: '{}',
  })
}

export async function pollDeviceFlow(baseUrl: string, state: string): Promise<PollResult> {
  return request<PollResult>(baseUrl, `/api/cli/auth/poll/${encodeURIComponent(state)}`, {
    method: 'GET',
  })
}

export async function getWorkspaces(baseUrl: string, bearer: string): Promise<WorkspacesResponse> {
  return request<WorkspacesResponse>(baseUrl, '/api/cli/workspaces', {
    method: 'GET',
    bearer,
  })
}

export { isApiError }
