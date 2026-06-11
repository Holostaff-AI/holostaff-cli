/**
 * Narrow auth shape the deploy API client needs. Built from the CLI's
 * `resolveAuth()` (auth/credentials.ts) after the caller has verified
 * the session is present + unexpired — so `token` is non-optional here.
 */

export interface DeployAuth {
  token: string
  baseUrl: string
  workspaceId?: string
}
