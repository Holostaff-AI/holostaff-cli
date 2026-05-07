/**
 * Turn a RepoDetection into a single human-readable sentence the
 * welcome screen can show. Tone matches PRD §4.8 — concise,
 * confident, no filler.
 */

import type { RepoDetection, DetectedPackage, Framework } from './repo.js'

const FRAMEWORK_LABELS: Record<Framework, string> = {
  vue3: 'Vue 3',
  react: 'React',
  next: 'Next.js',
  nuxt: 'Nuxt',
  svelte: 'SvelteKit',
  astro: 'Astro',
  remix: 'Remix',
  'firebase-functions': 'Firebase Functions',
  express: 'Express',
  fastify: 'Fastify',
  unknown: 'unknown framework',
}

export function describeRepo(d: RepoDetection): string {
  if (d.packages.length === 0) {
    return `This directory doesn't look like a code repo I recognise (${d.sourceFileCount} source files, no package.json found). Run me from your project root.`
  }

  // Filter out "uninformative" root packages — a root package.json with
  // no recognised framework whose only role is to delegate scripts to
  // child packages. We still want to count it for multi-package
  // detection, but it shouldn't dominate the description.
  const meaningful = d.packages.filter((p) => p.framework !== 'unknown')

  if (meaningful.length === 0) {
    // All packages are framework-unknown — describe by structure only.
    return joinSentences([
      `Detected ${d.packages.length} package${d.packages.length === 1 ? '' : 's'} but no framework I recognise yet`,
      `${formatCount(d.sourceFileCount)} source files`,
      'Tell me more about what this repo is and I\'ll try to help',
    ])
  }

  if (meaningful.length === 1 && d.packages.length === 1) {
    const p = meaningful[0]!
    return joinSentences([
      `Detected a ${describePackage(p)} project`,
      describeNotables(d, p),
      `${formatCount(d.sourceFileCount)} source files. Looks like a real codebase — let's get going`,
    ])
  }

  // Multi-package — list the meaningful ones, ignore the noisy root.
  const parts = meaningful.map((p) => {
    const where = p.path === '.' ? 'root' : p.path
    return `${describePackage(p, true)} in ${where}/`
  })
  return joinSentences([
    `Detected a multi-package repo: ${parts.join(', ')}`,
    `${formatCount(d.sourceFileCount)} source files`,
    'I can scan all of them or you can pick — your call',
  ])
}

function joinSentences(parts: Array<string | undefined | null | false>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join('. ') + '.'
}

function describePackage(p: DetectedPackage, terse = false): string {
  const fw = FRAMEWORK_LABELS[p.framework]
  const lang = p.language === 'typescript' ? ' + TypeScript' : ''
  if (terse) return fw
  return `${fw}${lang}`
}

function describeNotables(d: RepoDetection, primaryPkg: DetectedPackage): string {
  // Surface dirs that aren't the primary package's root
  const primaryDir = primaryPkg.path === '.' ? '' : primaryPkg.path.split('/')[0]
  const others = d.notableDirs.filter(
    (dir) => dir !== primaryDir && dir !== 'src' && dir !== 'public' && dir !== 'test',
  )
  if (others.length === 0) return ''
  if (others.length === 1) return `with a ${others[0]}/ subdirectory`
  if (others.length <= 3) return `with ${others.map((d) => `${d}/`).join(', ')} alongside`
  return `with ${others.slice(0, 2).map((d) => `${d}/`).join(', ')} and ${others.length - 2} other top-level dirs`
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
