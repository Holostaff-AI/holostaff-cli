/**
 * A2.5 — upload smoke against the deployed Holostaff API.
 *
 * Drives uploadFlow with hardcoded TutorLM-shaped findings so we can
 * validate the create-source-or-reuse / upload / write-binding path
 * without burning a 3-minute scan. Also useful for quick regression
 * checks after server-side changes.
 *
 * Required: an existing `~/.holostaff/credentials.json` from a prior
 * `holostaff login`. The smoke uses the bearer token from there.
 *
 * Notes:
 * - Writes `.holostaff/source.json` in the *current* directory on
 *   first run. Re-run uses the binding (uploads version 2, 3, …).
 *   To force a fresh source create, rm the file before re-running.
 * - Optional env: HOLOSTAFF_APP_BASE_URL (default www.holostaff.ai).
 *
 * Run:  cd cli && npm run spike:upload
 */

import { resolveAuth } from '../auth/credentials.js'
import { uploadFlow, type UploadEvent } from '../agent/uploadArtifact.js'
import type { UploadArtifactBody } from '../auth/api.js'

function need<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) {
    console.error(`✗ ${label} is missing`)
    process.exit(2)
  }
  return v
}

const auth = resolveAuth()
if (auth.source === 'none') {
  console.error('✗ Not signed in. Run `holostaff login` first.')
  process.exit(2)
}
if (auth.expired) {
  console.error('✗ Token expired. Run `holostaff login` to refresh.')
  process.exit(2)
}

const bearer = need(auth.token, 'token')
const workspaceId = need(auth.workspaceId, 'workspaceId')
const appBaseUrl = process.env.HOLOSTAFF_APP_BASE_URL ?? 'https://www.holostaff.ai'

const sample: UploadArtifactBody = {
  runId: `cli_${Date.now().toString(36)}_smoke`,
  ingestedVia: 'cli_scan',
  ingestedAt: new Date().toISOString(),
  productName: 'TutorLM',
  oneLineDescription:
    'A voice-first, one-on-one AI tutor for learning artificial intelligence, paired with a real-time visual knowledge canvas.',
  primaryFramework: 'vue3',
  language: 'typescript',
  routes: [
    { path: '/', description: 'Marketing landing for unauthenticated visitors; dashboard for learners.' },
    { path: '/goals', description: 'Goal catalog filterable by AI category.' },
  ],
  components: [
    { name: 'LandingPage', role: 'unauthenticated marketing page' },
    { name: 'VoiceDock', role: 'voice tutor connection control' },
  ],
  copy: [
    { text: 'Continue your learning journey', location: 'DashboardGreeting.vue:5' },
  ],
  brandVoice: { tone: 'warm + plainspoken', keywords: ['learning', 'goal'], avoidTerms: [] },
  workflows: [
    {
      name: 'Sign up and pick a goal',
      steps: ['Land on marketing page', 'Sign in', 'Browse catalog', 'Pick a goal'],
      entryRoute: '/',
    },
  ],
  coverageGaps: ['Did not read backend functions (smoke fixture).'],
  notes: 'Smoke-test fixture from cli/src/spike/uploadSmoke.ts',
}

console.log('Holostaff CLI — upload smoke (A2.5)')
console.log(`  baseUrl:     ${auth.baseUrl}`)
console.log(`  appBaseUrl:  ${appBaseUrl}`)
console.log(`  workspaceId: ${workspaceId}`)
console.log(`  cwd:         ${process.cwd()}`)
console.log()

const result = await uploadFlow({
  cwd: process.cwd(),
  baseUrl: auth.baseUrl,
  bearer,
  workspaceId,
  appBaseUrl,
  artifact: sample,
  onEvent: (ev: UploadEvent) => {
    switch (ev.type) {
      case 'resolving_source':         console.log('· resolving source…'); break
      case 'reusing_source':           console.log(`✓ reusing source ${ev.name} (${ev.sourceId})`); break
      case 'wrong_workspace_binding': console.log(`! existing binding is for ${ev.bindingWorkspaceId}, current is ${ev.currentWorkspaceId} — creating fresh`); break
      case 'binding_malformed':        console.log(`! binding malformed (${ev.error}) — creating fresh`); break
      case 'creating_source':          console.log(`· creating source “${ev.name}”…`); break
      case 'source_created':           console.log(`✓ source created: ${ev.name} (${ev.sourceId})`); break
      case 'uploading':                console.log(`· uploading artifact to ${ev.sourceId}…`); break
      case 'uploaded':                 console.log(`✓ uploaded artifact ${ev.artifactId} (version ${ev.version})`); break
      case 'binding_written':          console.log(`✓ wrote binding to ${ev.path}`); break
      case 'failed':                   console.log(`✗ ${ev.error}`); break
    }
  },
})

console.log()
if (result.ok) {
  console.log(`✓ done — view at ${result.viewUrl}`)
  process.exit(0)
}
console.log(`✗ failed during ${result.step}: ${result.error}`)
process.exit(1)
