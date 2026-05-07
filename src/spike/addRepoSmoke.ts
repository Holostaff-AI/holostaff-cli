/**
 * A4 — /scan --add-repo smoke against the deployed API.
 *
 * Exercises the server-side merge logic without going through the
 * Ink UI. We:
 *   1. fetch the live artifact's current state
 *   2. construct fresh-but-overlapping findings (mostly different
 *      routes/components/copy than what's there now)
 *   3. POST with mergeMode='append' against the bound source
 *   4. read the new live artifact, confirm:
 *      - prev items still present
 *      - new items appended
 *      - duplicates collapsed by identity
 *      - product-level fields kept from prev
 *
 * Required: ~/.holostaff/credentials.json + a .holostaff/source.json
 * binding in the cwd. Run from /tmp/holostaff-smoke-cwd which has the
 * test source from A2.5 / A4 refine.
 */

import { resolveAuth } from '../auth/credentials.js'
import { readBinding } from '../binding/sourceBinding.js'
import {
  getCliArtifact,
  getCliSource,
  uploadArtifact,
  type UploadArtifactBody,
} from '../auth/api.js'

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

const auth = resolveAuth()
if (auth.source === 'none' || auth.expired || !auth.token || !auth.workspaceId) {
  fail('Not signed in / token expired. Run `holostaff login` first.')
}

const bind = readBinding(process.cwd(), auth.workspaceId!)
if (bind.kind !== 'found') {
  fail(`No usable source binding in ${process.cwd()} (kind=${bind.kind}).`)
}

console.log('Holostaff CLI — /scan --add-repo smoke (A4)')
console.log(`  cwd:         ${process.cwd()}`)
console.log(`  workspaceId: ${auth.workspaceId}`)
console.log(`  sourceId:    ${bind.binding.sourceId}`)
console.log()

const baseUrl = auth.baseUrl
const bearer = auth.token!

// 1. fetch source for liveArtifactVersion
const { source } = await getCliSource(baseUrl, bearer, bind.binding.sourceId)
const prevVersion = source.liveArtifactVersion
if (!prevVersion) fail('Source has no liveArtifactVersion. Upload a baseline scan first.')

const prev = await getCliArtifact(baseUrl, bearer, bind.binding.sourceId, prevVersion!)
console.log(`✓ prev v${prevVersion}: ${prev.artifact.routes.length} routes, ${prev.artifact.components.length} components, ${prev.artifact.copy.length} copy, ${prev.artifact.workflows.length} workflows, gaps=${prev.artifact.coverageGaps.length}`)
const prevPaths = new Set(prev.artifact.routes.map((r) => r.path))

// 2. construct findings that overlap a little, mostly fresh
const newPayload: UploadArtifactBody = {
  runId: `cli_${Date.now().toString(36)}_addrepo`,
  ingestedVia: 'cli_scan',
  ingestedAt: new Date().toISOString(),
  productName: 'NameThatShouldBeIgnored',
  oneLineDescription: 'description that should be ignored on append',
  primaryFramework: 'frameworkThatShouldBeIgnored',
  language: 'javascript', // different from prev (typescript) — should be ignored
  routes: [
    // Overlap with prev: '/' should dedupe by path; new description wins
    { path: '/', description: 'OVERWRITTEN by add-repo smoke', file: 'addRepoSmoke.ts' },
    // Fresh: new path
    { path: '/marketing/about', description: 'about page from a separate marketing repo', file: 'about.vue' },
    { path: '/marketing/changelog', description: 'changelog page', file: 'changelog.vue' },
  ],
  components: [
    { name: 'MarketingHero', role: 'top-of-fold landing hero', file: 'marketing/Hero.vue' },
  ],
  copy: [
    { text: 'Sign up for a free trial', location: 'marketing/Hero.vue:42' },
    { text: 'Read the changelog', location: 'marketing/Footer.vue:9' },
  ],
  workflows: [
    {
      name: 'Subscribe to product updates',
      steps: ['Visit marketing site', 'Open changelog', 'Click subscribe', 'Confirm email'],
      entryRoute: '/marketing/changelog',
    },
  ],
  brandVoice: { tone: 'voice that should be ignored', keywords: [], avoidTerms: [] },
  coverageGaps: ['Did not read marketing site components beyond Hero (smoke)'],
  notes: 'Add-repo smoke contributed routes from a marketing repo.',
}

// 3. upload with mergeMode='append'
console.log()
console.log(`· POST artifact (mergeMode='append')`)
const uploadRes = await uploadArtifact(baseUrl, bearer, bind.binding.sourceId, newPayload, 'append')
console.log(`✓ uploaded v${uploadRes.version} (${uploadRes.artifactId})`)

// 4. read back and verify merges
const next = await getCliArtifact(baseUrl, bearer, bind.binding.sourceId, uploadRes.version)
const a = next.artifact
console.log()
console.log(`· verifying merge`)
console.log(`  productName:        ${JSON.stringify(a.productName)} (kept from prev: ${a.productName === prev.artifact.productName})`)
console.log(`  oneLineDescription: kept from prev: ${a.oneLineDescription === prev.artifact.oneLineDescription}`)
console.log(`  language:           ${a.language} (kept from prev: ${a.language === prev.artifact.language})`)
console.log()
console.log(`  routes:      ${a.routes.length}`)
const slashRoute = a.routes.find((r) => r.path === '/')
console.log(`    /          present, description="${slashRoute?.description}" — overwritten=${slashRoute?.description?.startsWith('OVERWRITTEN')}`)
const aboutRoute = a.routes.find((r) => r.path === '/marketing/about')
console.log(`    /marketing/about: ${aboutRoute ? '✓ added' : '✗ missing'}`)
for (const path of prevPaths) {
  if (path === '/') continue
  const stillThere = a.routes.find((r) => r.path === path)
  if (!stillThere) {
    console.log(`    ✗ prev route ${path} disappeared`)
  }
}

console.log(`  components:  ${a.components.length} (added 1 ⇒ expected ${prev.artifact.components.length + 1})`)
console.log(`  copy:        ${a.copy.length} (added 2 ⇒ expected ${prev.artifact.copy.length + 2})`)
console.log(`  workflows:   ${a.workflows.length} (added 1 ⇒ expected ${prev.artifact.workflows.length + 1})`)
console.log(`  gaps:        ${a.coverageGaps.length} (prev=${prev.artifact.coverageGaps.length}, +1 added)`)

// Quick assertions
const issues: string[] = []
if (a.productName !== prev.artifact.productName) issues.push('productName changed')
if (a.oneLineDescription !== prev.artifact.oneLineDescription) issues.push('oneLineDescription changed')
if (a.language !== prev.artifact.language) issues.push('language changed')
if (slashRoute?.description !== 'OVERWRITTEN by add-repo smoke') issues.push('/ not overwritten')
if (!aboutRoute) issues.push('/marketing/about not appended')
if (a.components.length !== prev.artifact.components.length + 1) issues.push(`components count off (${a.components.length} vs expected ${prev.artifact.components.length + 1})`)
if (a.copy.length !== prev.artifact.copy.length + 2) issues.push(`copy count off (${a.copy.length} vs expected ${prev.artifact.copy.length + 2})`)
if (a.workflows.length !== prev.artifact.workflows.length + 1) issues.push(`workflows count off`)

console.log()
if (issues.length === 0) {
  console.log(`✓ all checks passed`)
  console.log(`  view at ${(process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai').replace(/\/+$/, '')}/knowledge-sources/${bind.binding.sourceId}`)
  process.exit(0)
}
console.log(`✗ ${issues.length} issue(s):`)
for (const i of issues) console.log(`  - ${i}`)
process.exit(1)
