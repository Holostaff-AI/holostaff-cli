/**
 * Stable SHA-1 hash of customerEdits — pair for the server's
 * `editsKeyOf` in server/src/bowtie/knowledge/deltaMerge.ts and the
 * dashboard's `computeEditsKey` in stores/bowtieKnowledgeStore.js.
 *
 * Sorting object keys before stringify means the hash is order-
 * independent — the same edits keyed differently still hash the same.
 */

import { createHash } from 'node:crypto'

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
  return `{${parts.join(',')}}`
}

export function editsKeyOf(edits: Record<string, unknown> | undefined | null): string {
  const normalized = edits ?? {}
  if (Object.keys(normalized).length === 0) return 'empty'
  return createHash('sha1').update(stableStringify(normalized)).digest('hex')
}
