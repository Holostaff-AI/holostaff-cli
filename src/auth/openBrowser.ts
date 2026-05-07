/**
 * Cross-platform "open this URL in the user's default browser." No
 * extra dep — shells out to the platform native opener. Best-effort:
 * if it fails (headless env, missing tool), we fall back to printing
 * the URL and letting the user copy-paste.
 */

import { spawn } from 'node:child_process'
import { platform } from 'node:os'

export type OpenResult = 'opened' | 'fallback'

export async function openUrl(url: string): Promise<OpenResult> {
  const cmd = openerCommand(url)
  if (!cmd) return 'fallback'

  return new Promise<OpenResult>((resolve) => {
    try {
      const child = spawn(cmd.bin, cmd.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => resolve('fallback'))
      child.unref()
      // Give it a tick — if it spawned, we won, regardless of how the
      // browser itself ends up handling the URL.
      setTimeout(() => resolve('opened'), 100)
    } catch {
      resolve('fallback')
    }
  })
}

function openerCommand(url: string): { bin: string; args: string[] } | null {
  const p = platform()
  if (p === 'darwin') return { bin: 'open', args: [url] }
  if (p === 'win32') return { bin: 'cmd', args: ['/c', 'start', '""', url] }
  // linux + other unix-likes
  return { bin: 'xdg-open', args: [url] }
}
