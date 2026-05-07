/**
 * A2.4 — non-interactive trust-report snapshot.
 *
 * Renders <TrustReport/> with hardcoded "TutorLM-shaped" findings (drawn
 * from the real A2.2 scan output) and exits as soon as the first frame
 * paints. Use this to iterate on the layout without burning a real
 * scan run, or to verify the view in environments without a TTY for
 * keypress input.
 *
 * Run:  cd cli && npm run spike:trust-report
 */

import React from 'react'
import { render } from 'ink'
import { TrustReport } from '../ui/scan/TrustReport.js'
import type { ScanFindings } from '../agent/findingsSchema.js'

const findings: ScanFindings = {
  productName: 'TutorLM',
  oneLineDescription:
    'A voice-first, one-on-one AI tutor for learning artificial intelligence, paired with a real-time visual knowledge canvas that uses dual-coding pedagogy to make concepts stick.',
  primaryFramework: 'vue3',
  language: 'typescript',
  routes: [
    { path: '/', description: 'Home: marketing landing for unauthenticated visitors; personalized dashboard for learners.', file: 'client/src/views/HomeView.vue' },
    { path: '/goals', description: 'Goal catalog: browse all learning goals filterable by AI category and difficulty.', file: 'client/src/views/GoalCatalogView.vue' },
    { path: '/goals/:goalId', description: 'Goal detail: view curriculum, commit, set schedule, track progress.', file: 'client/src/views/GoalDetailView.vue' },
    { path: '/course/:courseId', description: 'Course overview with chapter list and prerequisites.', file: 'client/src/views/CourseView.vue' },
    { path: '/pricing', description: 'Pricing page with plan tiers and FAQ.', file: 'client/src/views/PricingView.vue' },
  ],
  components: [
    { name: 'LandingPage', role: 'unauthenticated marketing page', file: 'client/src/components/LandingPage.vue' },
    { name: 'StudioDashboard', role: 'authenticated learner dashboard', file: 'client/src/views/StudioDashboard.vue' },
    { name: 'VoiceDock', role: 'voice tutor connection control', file: 'client/src/components/VoiceDock.vue' },
    { name: 'AuthModal', role: 'sign-in / sign-up dialog', file: 'client/src/components/AuthModal.vue' },
    { name: 'PaywallModal', role: 'plan-limit upgrade prompt', file: 'client/src/components/PaywallModal.vue' },
  ],
  copy: [
    { text: 'Continue your learning journey', location: 'DashboardGreeting.vue:5' },
    { text: 'Start a one-on-one session', location: 'LandingPage.vue:24' },
    { text: 'Built for self-directed learners', location: 'LandingPage.vue:38' },
    { text: 'You\'ve hit your free plan limit', location: 'PaywallModal.vue:11' },
    { text: 'Set a study schedule', location: 'GoalDetailView.vue:74' },
    { text: 'Goal catalog', location: 'GoalCatalogView.vue:9' },
    { text: 'Pricing', location: 'PricingView.vue:3' },
  ],
  brandVoice: {
    tone: 'warm + plainspoken, a little playful',
    keywords: ['learning', 'goal', 'commit', 'schedule', 'chapter', 'progress'],
    avoidTerms: ['student', 'enrollment'],
  },
  workflows: [
    {
      name: 'Sign up and pick a goal',
      steps: [
        'Land on the marketing page',
        'Click "Get started" → AuthModal',
        'Sign in with Google or email',
        'Browse the Goal catalog',
        'Click a goal → Goal detail',
        'Click "Commit to this goal"',
      ],
      entryRoute: '/',
    },
    {
      name: 'Run a tutoring session',
      steps: [
        'Open a course',
        'Click a chapter',
        'BoardView opens with the visual canvas',
        'VoiceDock connects to the realtime tutor',
        'Tutor narrates, draws nodes, asks assessment questions',
      ],
      entryRoute: '/course/:courseId/chapter/:chapterId',
    },
  ],
  coverageGaps: [
    'Did not read individual canvas node components (TextNode, AssessmentNode, CodeNode, etc.) in client/src/components/nodes/',
    'Did not read VueFlowWrapper.vue contents beyond first 10 lines',
    'Did not read backend Cloud Functions source files (functions/src/) — error messages and API copy not captured',
    'Did not read scheduling store (client/src/store/scheduling.ts) or composables in detail',
  ],
}

const noop = () => { /* snapshot only */ }

const { waitUntilExit, unmount } = render(
  React.createElement(TrustReport, {
    findings,
    durationMs: 183_078,
    tokensIn: 6_183,
    tokensOut: 9_309,
    onConfirm: noop,
    onSaveLocal: noop,
    onCancel: noop,
    inputDisabled: true,
  }),
)

// One render is enough — exit as soon as React has flushed.
setTimeout(() => unmount(), 100)
await waitUntilExit()
