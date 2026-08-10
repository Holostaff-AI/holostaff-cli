/**
 * Preset journey maps — `holostaff scan --from <path|url>`.
 *
 * Some products have already been scanned. Every self-hoster of an open
 * source app would otherwise spend nine minutes and a model budget
 * re-deriving a map of the same public code. A preset is that scan,
 * published once and imported in a second.
 *
 * The file is a scan artifact. Both shapes are accepted so a preset can
 * be produced either by publishing a `scan --out` result or by pulling
 * an existing map straight off the API:
 *
 *   { "productName": ..., "workflows": [...] }        // bare artifact
 *   { "artifact": { "productName": ..., ... } }       // API response
 *
 * Server-owned fields (ids, version, tenant, customer edits) are
 * dropped: the importer gets their own source, their own version, and
 * their own copy to edit. Provenance is kept honest with
 * `ingestedVia: 'cli_preset'`.
 */

import { readFile } from 'node:fs/promises'
import type { CliArtifactUpload } from './mapToArtifact.js'

/** Fields the server owns. Carrying them over would claim another
 *  tenant's identity or another workspace's edits. */
const SERVER_OWNED = [
  'id', 'sourceId', 'tenantId', 'version', 'ingestedAt', 'ingestedVia',
  'runId', 'updates', 'customerEdits', 'stageCopilots', 'depth',
] as const

export interface LoadedPreset {
  artifact: CliArtifactUpload
  /** Where it came from, for the status line. */
  origin: string
}

export class PresetError extends Error {}

/** Where named presets live. The CLI's own repo, so presets version with
 *  the tool, are open source themselves, and adding one needs no release
 *  and no server. `import opnform` resolves against this. */
const REGISTRY_BASE =
  'https://raw.githubusercontent.com/Holostaff-AI/holostaff-cli/master/presets'

/** A bare product name: no path separator, no extension, no scheme. */
function isBareName(from: string): boolean {
  return !/[/\\.:]/.test(from)
}

export interface PresetListing {
  name: string
  product: string
  description?: string
}

/** Fetch the registry index for `holostaff import` with no argument. */
export async function listPresets(): Promise<PresetListing[]> {
  const res = await fetch(`${REGISTRY_BASE}/index.json`).catch((err: Error) => {
    throw new PresetError(`could not reach the preset registry: ${err.message}`)
  })
  if (!res.ok) throw new PresetError(`preset registry: HTTP ${res.status}`)
  const parsed = await res.json() as { presets?: PresetListing[] }
  return parsed.presets ?? []
}

async function readSource(from: string): Promise<string> {
  if (isBareName(from)) {
    const url = `${REGISTRY_BASE}/${from}.json`
    const res = await fetch(url, { redirect: 'follow' }).catch((err: Error) => {
      throw new PresetError(`could not fetch preset '${from}': ${err.message}`)
    })
    if (res.status === 404) {
      const known = await listPresets().then(
        (l) => l.map((p) => p.name).join(', '),
        () => null,
      )
      throw new PresetError(
        `no preset named '${from}'${known ? ` (available: ${known})` : ''}`,
      )
    }
    if (!res.ok) throw new PresetError(`could not fetch preset '${from}': HTTP ${res.status}`)
    return await res.text()
  }
  if (/^https?:\/\//i.test(from)) {
    if (!/^https:\/\//i.test(from)) {
      throw new PresetError('--from over plain http is refused; use https or a local path')
    }
    const res = await fetch(from, { redirect: 'follow' }).catch((err: Error) => {
      throw new PresetError(`could not fetch ${from}: ${err.message}`)
    })
    if (!res.ok) throw new PresetError(`could not fetch ${from}: HTTP ${res.status}`)
    return await res.text()
  }
  return await readFile(from, 'utf8').catch((err: Error) => {
    throw new PresetError(`could not read ${from}: ${err.message}`)
  })
}

export async function loadPreset(from: string): Promise<LoadedPreset> {
  const raw = await readSource(from)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new PresetError(`${from} is not valid JSON: ${(err as Error).message}`)
  }

  const body = (parsed && typeof parsed === 'object' && 'artifact' in parsed)
    ? (parsed as { artifact: unknown }).artifact
    : parsed
  if (!body || typeof body !== 'object') {
    throw new PresetError(`${from} does not contain an artifact object`)
  }

  const src = { ...(body as Record<string, unknown>) }
  for (const key of SERVER_OWNED) delete src[key]

  for (const required of ['productName', 'primaryFramework', 'workflows']) {
    if (src[required] === undefined) {
      throw new PresetError(`${from} is missing "${required}"; is it a Holostaff journey map?`)
    }
  }
  if (!Array.isArray(src.workflows) || src.workflows.length === 0) {
    throw new PresetError(`${from} has no workflows; nothing to import`)
  }

  const artifact = {
    ...src,
    runId: `preset_${Date.now().toString(36)}`,
    ingestedVia: 'cli_preset',
    ingestedAt: new Date().toISOString(),
  } as unknown as CliArtifactUpload

  return { artifact, origin: from }
}
