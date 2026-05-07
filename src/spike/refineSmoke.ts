/**
 * A4 — /refine smoke against the deployed API.
 *
 * Drives the new bearer-auth GET artifact + PATCH edits endpoints
 * directly (no Ink UI) so we can validate the round-trip without a
 * TTY. Reads the source binding from cwd's .holostaff/source.json.
 *
 * What it does:
 *   1. read binding for current cwd
 *   2. GET source → liveArtifactVersion
 *   3. GET artifact at that version
 *   4. PATCH a productName + notes override on top of existing edits
 *   5. GET the artifact again, confirm the new edits land
 *
 * Run from a directory that has a binding (e.g. /tmp/holostaff-smoke-cwd
 * from A2.5):
 *
 *   cd /tmp/holostaff-smoke-cwd && \
 *   /home/galem/holostaff-agent/cli/node_modules/.bin/tsx \
 *   /home/galem/holostaff-agent/cli/src/spike/refineSmoke.ts
 */

import { resolveAuth } from '../auth/credentials.js'
import { readBinding } from '../binding/sourceBinding.js'
import {
  getCliArtifact,
  getCliSource,
  patchCliArtifactEdits,
} from '../auth/api.js'

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

const auth = resolveAuth()
if (auth.source === 'none') fail('Not signed in. Run `holostaff login` first.')
if (auth.expired) fail('Token expired. Run `holostaff login` to refresh.')
if (!auth.token || !auth.workspaceId) fail('Auth incomplete (token/workspaceId missing).')

const bind = readBinding(process.cwd(), auth.workspaceId!)
if (bind.kind !== 'found') {
  fail(`No usable source binding in ${process.cwd()} (kind=${bind.kind}). Run /scan first.`)
}

console.log('Holostaff CLI — refine smoke (A4)')
console.log(`  cwd:         ${process.cwd()}`)
console.log(`  workspaceId: ${auth.workspaceId}`)
console.log(`  sourceId:    ${bind.binding.sourceId}`)
console.log()

const baseUrl = auth.baseUrl
const bearer = auth.token!

// 1. fetch source for liveArtifactVersion
const { source } = await getCliSource(baseUrl, bearer, bind.binding.sourceId)
const version = source.liveArtifactVersion
if (!version) fail('Source has no liveArtifactVersion yet. Upload a scan first.')
console.log(`✓ source ${source.name} · live version ${version}`)

// 2. read current artifact
const r1 = await getCliArtifact(baseUrl, bearer, bind.binding.sourceId, version!)
console.log(`✓ artifact loaded: productName=${JSON.stringify(r1.artifact.productName)}, notes=${JSON.stringify(r1.artifact.notes ?? null)}`)
console.log(`  customerEdits keys: [${Object.keys(r1.artifact.customerEdits).join(', ') || '(none)'}]`)

// 3. compose new edits — layer overrides on existing
const newEdits = {
  ...r1.artifact.customerEdits,
  productName: `${r1.artifact.productName} (refined ${new Date().toISOString().slice(0, 10)})`,
  notes: 'A4 refine smoke wrote this scalar override.',
}
console.log()
console.log(`· PATCH /sources/${bind.binding.sourceId}/artifacts/${version}/edits`)
const r2 = await patchCliArtifactEdits(baseUrl, bearer, bind.binding.sourceId, version!, newEdits)
console.log(`✓ patched`)

// 4. read back and confirm
const r3 = await getCliArtifact(baseUrl, bearer, bind.binding.sourceId, version!)
const ce = r3.artifact.customerEdits as Record<string, unknown>
console.log()
console.log(`· verifying read-back`)
console.log(`  productName edit: ${JSON.stringify(ce.productName)}`)
console.log(`  notes edit:       ${JSON.stringify(ce.notes)}`)

const ok = ce.productName === newEdits.productName && ce.notes === newEdits.notes
if (!ok) {
  console.log()
  console.log('✗ round-trip mismatch')
  process.exit(1)
}

void r2
console.log()
console.log(`✓ done — view at ${(process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai').replace(/\/+$/, '')}/knowledge-sources/${bind.binding.sourceId}`)
process.exit(0)
