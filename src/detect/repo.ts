/**
 * Repo detection — runs at startup so the CLI can greet the user with
 * context-rich language ("looks like a Vue 3 + Vite app...") instead
 * of "Welcome to Holostaff CLI." This is the difference between feeling
 * like a tool that knows what you're doing and one that doesn't.
 *
 * Heuristic-based, intentionally fast (no LLM calls). The agent does
 * deeper analysis later in /scan.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface DetectedPackage {
  /** Path to the package's directory, relative to the cwd. */
  path: string
  /** Display name (from package.json or directory name). */
  name: string
  /** Detected primary framework. */
  framework: Framework
  /** Detected language. */
  language: 'typescript' | 'javascript' | 'unknown'
  /** Approximate role of this package in the repo. */
  role: 'frontend' | 'backend' | 'shared' | 'unknown'
}

export type Framework =
  | 'vue3'
  | 'react'
  | 'next'
  | 'nuxt'
  | 'svelte'
  | 'astro'
  | 'remix'
  | 'firebase-functions'
  | 'express'
  | 'fastify'
  | 'unknown'

export interface RepoDetection {
  /** Absolute repo root (the cwd we were invoked in). */
  root: string
  /** All package.json'd packages found, in the order discovered. */
  packages: DetectedPackage[]
  /** Total source-file count, excluding node_modules + .git + build dirs. */
  sourceFileCount: number
  /** True if the repo contains multiple package.json files (monorepo-ish). */
  isMultiPackage: boolean
  /** Top-level subdirectories worth surfacing in the welcome banner. */
  notableDirs: string[]
}

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro',
  '.html', '.css', '.scss',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'out', 'coverage', '.turbo', '.cache', '.firebase', '.holostaff',
  '_scratch', '.scratch',
])

/**
 * Walk the repo from `root`, returning a detection summary. Bounded
 * traversal: we don't recurse into SKIP_DIRS, and we stop counting at
 * `maxFiles` to avoid pegging on huge monorepos.
 */
export function detectRepo(root: string, opts: { maxFiles?: number } = {}): RepoDetection {
  const maxFiles = opts.maxFiles ?? 5_000

  const packages: DetectedPackage[] = []
  const notableDirsSet = new Set<string>()
  let sourceFileCount = 0

  // First pass: locate package.json files (depth ≤ 3 from root).
  walkForPackages(root, root, packages, 0, 3)

  // Second pass: count source files + collect notable directories.
  for (const entry of listDir(root)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(root, entry)
    const st = safeStat(full)
    if (!st) continue
    if (st.isDirectory()) {
      // Only surface non-trivial directories — skip dotted/config dirs
      // and anything we already represent via a package.
      if (!entry.startsWith('.') && !entry.startsWith('_')) {
        notableDirsSet.add(entry)
      }
      sourceFileCount += countSourceFiles(full, maxFiles - sourceFileCount)
    } else if (st.isFile() && hasSourceExt(entry)) {
      sourceFileCount += 1
    }
    if (sourceFileCount >= maxFiles) break
  }

  return {
    root,
    packages,
    sourceFileCount,
    isMultiPackage: packages.length > 1,
    notableDirs: Array.from(notableDirsSet).sort(),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function walkForPackages(
  root: string,
  dir: string,
  out: DetectedPackage[],
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth) return
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    out.push(readPackage(pkgPath, root))
    // Continue descending — many real repos have a "loose monorepo"
    // shape: root package.json (delegating scripts) + child packages
    // in client/, functions/, etc. We want all of them. Stopping at
    // the first match would miss the meaningful ones.
  }
  for (const entry of listDir(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const sub = join(dir, entry)
    const st = safeStat(sub)
    if (st?.isDirectory()) walkForPackages(root, sub, out, depth + 1, maxDepth)
  }
}

function readPackage(pkgPath: string, root: string): DetectedPackage {
  const dir = pkgPath.replace(/\/package\.json$/, '')
  const rel = relative(root, dir) || '.'
  let parsed: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
  try { parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { /* malformed, treat as empty */ }
  const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }
  const framework = detectFramework(deps, dir)
  const language = detectLanguage(dir)
  return {
    path: rel,
    name: parsed.name || rel || 'unnamed',
    framework,
    language,
    role: inferRole(framework, rel),
  }
}

function detectFramework(deps: Record<string, string>, dir: string): Framework {
  if (deps['next']) return 'next'
  if (deps['nuxt']) return 'nuxt'
  if (deps['astro']) return 'astro'
  if (deps['@remix-run/node'] || deps['@remix-run/serve']) return 'remix'
  if (deps['svelte'] || deps['@sveltejs/kit']) return 'svelte'
  if (deps['vue']) return 'vue3'
  if (deps['react']) return 'react'
  if (deps['firebase-functions']) return 'firebase-functions'
  if (deps['fastify']) return 'fastify'
  if (deps['express']) return 'express'
  // Last-ditch: look at vite config presence → likely Vue/React, fall through.
  if (existsSync(join(dir, 'vite.config.ts')) || existsSync(join(dir, 'vite.config.js'))) {
    return 'unknown' // can't tell which without deps
  }
  return 'unknown'
}

function detectLanguage(dir: string): DetectedPackage['language'] {
  if (existsSync(join(dir, 'tsconfig.json'))) return 'typescript'
  // Look for any .ts files at top level
  for (const entry of listDir(dir)) {
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) return 'typescript'
  }
  return 'javascript'
}

function inferRole(fw: Framework, relPath: string): DetectedPackage['role'] {
  const path = relPath.toLowerCase()
  if (path.includes('client') || path.includes('frontend') || path.includes('web')) return 'frontend'
  if (path.includes('server') || path.includes('functions') || path.includes('backend') || path.includes('api')) return 'backend'
  if (['vue3', 'react', 'next', 'nuxt', 'svelte', 'astro', 'remix'].includes(fw)) return 'frontend'
  if (['firebase-functions', 'express', 'fastify'].includes(fw)) return 'backend'
  if (path.includes('shared') || path.includes('common') || path.includes('packages')) return 'shared'
  return 'unknown'
}

function listDir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function safeStat(p: string) {
  try { return statSync(p) } catch { return null }
}

function hasSourceExt(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return SOURCE_EXTS.has(name.slice(dot))
}

function countSourceFiles(dir: string, budget: number): number {
  if (budget <= 0) return 0
  let count = 0
  const entries = listDir(dir)
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = safeStat(full)
    if (!st) continue
    if (st.isDirectory()) {
      count += countSourceFiles(full, budget - count)
    } else if (st.isFile() && hasSourceExt(entry)) {
      count += 1
    }
    if (count >= budget) return count
  }
  return count
}
