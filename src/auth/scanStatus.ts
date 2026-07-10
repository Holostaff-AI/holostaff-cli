/**
 * Fire-and-forget scan-status pings. The dashboard's home hub listens on
 * cli/scan_status/{workspaceId} and shows "scan in progress" the moment
 * the CLI starts working — the terminal and the app stay in sync without
 * the user refreshing anything.
 *
 * Never throws, never blocks the scan: status is a courtesy signal, and
 * a network hiccup here must not degrade the actual work.
 */

import { resolveAuth } from './credentials.js'

export type ScanStatusPhase = 'started' | 'uploading' | 'done' | 'failed'

export function postScanStatus(input: {
  phase: ScanStatusPhase
  repoName?: string
  detail?: string
}): void {
  const auth = resolveAuth()
  if (!auth.token || auth.expired) return
  void fetch(`${auth.baseUrl}/api/cli/scan-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auth.token}`,
    },
    body: JSON.stringify(input),
  }).catch(() => { /* best-effort */ })
}
