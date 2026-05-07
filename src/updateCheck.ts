/**
 * Update check — surfaces a banner when a newer @holostaff/cli is on
 * npm. Fire-and-forget: never blocks startup, never crashes the CLI.
 *
 * Cached for 24h in `os.tmpdir()/holostaff-update-check.json` so we
 * don't hit the registry on every invocation. The cache stores
 * `{ latest, fetchedAt }`; readers use it if it's fresh and either
 * trigger a background refresh on miss or skip the check entirely.
 *
 * Opt-out: HOLOSTAFF_UPDATE_CHECK=0 disables. Honored alongside the
 * telemetry opt-out so a fully-private install stays silent.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CACHE_FILE = join(tmpdir(), 'holostaff-update-check.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REGISTRY_URL = 'https://registry.npmjs.org/@holostaff/cli/latest'
const REQUEST_TIMEOUT_MS = 2500

interface CacheEntry {
  latest: string
  fetchedAt: number
}

function isDisabled(): boolean {
  const v = process.env.HOLOSTAFF_UPDATE_CHECK
  return v === '0' || v === 'false' || v === 'off'
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8')
    const entry = JSON.parse(raw) as CacheEntry
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
    if (typeof entry.latest !== 'string') return null
    return entry
  } catch {
    return null
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  try {
    await writeFile(CACHE_FILE, JSON.stringify(entry), 'utf8')
  } catch {
    // Cache writes are best-effort; cwd may be read-only on CI hosts.
  }
}

async function fetchLatest(): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(REGISTRY_URL, { signal: ctrl.signal })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Strict-but-tiny semver compare. Returns true iff a > b for x.y.z form. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return false
}

/**
 * Returns the latest version if it's newer than `current`, else null.
 * Resolves quickly off the cache; on a cache miss, kicks off a
 * background refresh and resolves null this run.
 */
export async function checkForUpdate(current: string): Promise<string | null> {
  if (isDisabled()) return null

  const cached = await readCache()
  if (cached) {
    return isNewer(cached.latest, current) ? cached.latest : null
  }

  // No fresh cache — refresh now (still fire-and-forget from caller's view
  // because the App mounts the banner from a useEffect that swallows
  // late results gracefully).
  const latest = await fetchLatest()
  if (!latest) return null
  await writeCache({ latest, fetchedAt: Date.now() })
  return isNewer(latest, current) ? latest : null
}
