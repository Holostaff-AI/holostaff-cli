/**
 * Upload orchestrator — runs after the user confirms the trust report.
 *
 * Three phases, each emitting a typed UploadEvent so the UI can show
 * meaningful progress instead of a silent spinner:
 *
 *   1. resolve_source — check `.holostaff/source.json`. If present and
 *      bound to the current workspace, reuse. If missing, create a
 *      new draft source named after `findings.productName`. If bound
 *      to a different workspace, treat as missing (don't reuse) and
 *      surface the conflict in the event.
 *
 *   2. upload — POST the artifact body to /api/cli/sources/:id/artifacts.
 *      Server synthesizes (computes diffs vs prev artifact, carries
 *      forward customer edits), writes RTDB, returns version + id.
 *
 *   3. persist_binding — write `.holostaff/source.json` so the next
 *      scan in this repo binds to the same source.
 *
 * Returns a UploadResult discriminated on `ok` so callers can render
 * success-with-link vs. failure-with-error uniformly.
 */

import {
  createCliSource,
  uploadArtifact as apiUploadArtifact,
  type UploadArtifactBody,
} from '../auth/api.js'
import {
  readBinding,
  writeBinding,
  bindingPath,
  type SourceBinding,
} from '../binding/sourceBinding.js'

export type UploadEvent =
  | { type: 'resolving_source' }
  | { type: 'reusing_source'; sourceId: string; name: string }
  | { type: 'wrong_workspace_binding'; bindingWorkspaceId: string; currentWorkspaceId: string }
  | { type: 'binding_malformed'; error: string }
  | { type: 'creating_source'; name: string }
  | { type: 'source_created'; sourceId: string; name: string }
  | { type: 'uploading'; sourceId: string }
  | { type: 'uploaded'; sourceId: string; version: number; artifactId: string }
  | { type: 'binding_written'; path: string }
  | { type: 'failed'; error: string }

export type UploadResult =
  | {
      ok: true
      sourceId: string
      sourceName: string
      version: number
      artifactId: string
      viewUrl: string
      bindingPath: string
      isNewSource: boolean
    }
  | {
      ok: false
      error: string
      step: 'resolve_source' | 'upload' | 'persist_binding'
    }

export interface UploadOptions {
  /** Repository root — where `.holostaff/source.json` lives. */
  cwd: string
  /** Holostaff API base URL (from credentials). */
  baseUrl: string
  /** Bearer JWT (from credentials). */
  bearer: string
  /** Workspace id from the bearer; we double-check the binding matches. */
  workspaceId: string
  /** App base URL for the human-visible "view at …" link. */
  appBaseUrl: string
  /** What the agent extracted; provides productName + repo context. */
  artifact: UploadArtifactBody
  /**
   * Optional repo origin marker (e.g. 'github.com/foo/bar' from `git
   * remote get-url`). Recorded on the source for dashboard display.
   * Caller resolves this since we don't run git here.
   */
  repoOrigin?: string
  /**
   * 'replace' (default): findings overwrite the existing artifact.
   * 'append':  merge into the existing artifact (used by --add-repo).
   * Set by Scan when the user opted into multi-repo mode; the server
   * dedupes by item identity.
   */
  mergeMode?: 'replace' | 'append'
  /**
   * When set, the upload binds to this sourceId regardless of any
   * existing local binding — used by --add-repo, where the user
   * picked an existing source to contribute to. Overwrites the
   * .holostaff/source.json on success.
   */
  forceSourceId?: { sourceId: string; sourceName: string }
  onEvent?: (ev: UploadEvent) => void
}

export async function uploadFlow(options: UploadOptions): Promise<UploadResult> {
  const {
    cwd, baseUrl, bearer, workspaceId, appBaseUrl, artifact,
    repoOrigin, mergeMode = 'replace', forceSourceId, onEvent,
  } = options
  const emit = onEvent ?? (() => {})

  // Phase 1 — resolve source. Three paths:
  //   - forceSourceId set (--add-repo): use it, ignore any existing
  //     local binding, mark as needing rebind.
  //   - found binding for current workspace: reuse.
  //   - missing / wrong_workspace / malformed: create fresh.
  emit({ type: 'resolving_source' })
  let sourceId: string
  let sourceName: string
  // isNewSource gates whether we write the binding. true when we just
  // created one OR when --add-repo rebinds to a different existing
  // source.
  let isNewSource = false

  try {
    if (forceSourceId) {
      sourceId = forceSourceId.sourceId
      sourceName = forceSourceId.sourceName
      // Always rebind on --add-repo so subsequent scans land on the
      // chosen source. emit a 'reusing' event with a flag so the UI
      // can say "rebinding to existing source X".
      emit({ type: 'reusing_source', sourceId, name: sourceName })
      isNewSource = true // forces phase-3 binding write
    } else {
      const read = readBinding(cwd, workspaceId)
      switch (read.kind) {
        case 'found': {
          sourceId = read.binding.sourceId
          sourceName = read.binding.name
          emit({ type: 'reusing_source', sourceId, name: sourceName })
          break
        }
        case 'wrong_workspace': {
          emit({
            type: 'wrong_workspace_binding',
            bindingWorkspaceId: read.binding.workspaceId,
            currentWorkspaceId: workspaceId,
          })
          // Fall through to create-fresh; we don't overwrite the existing
          // binding silently — caller can decide later (UX in v2).
          const created = await createSource(baseUrl, bearer, artifact.productName, repoOrigin)
          sourceId = created.id
          sourceName = created.name
          isNewSource = true
          emit({ type: 'source_created', sourceId, name: sourceName })
          break
        }
        case 'malformed': {
          emit({ type: 'binding_malformed', error: read.error })
          const created = await createSource(baseUrl, bearer, artifact.productName, repoOrigin)
          sourceId = created.id
          sourceName = created.name
          isNewSource = true
          emit({ type: 'source_created', sourceId, name: sourceName })
          break
        }
        case 'missing': {
          emit({ type: 'creating_source', name: artifact.productName })
          const created = await createSource(baseUrl, bearer, artifact.productName, repoOrigin)
          sourceId = created.id
          sourceName = created.name
          isNewSource = true
          emit({ type: 'source_created', sourceId, name: sourceName })
          break
        }
      }
    }
  } catch (err) {
    const error = (err as Error).message
    emit({ type: 'failed', error })
    return { ok: false, error, step: 'resolve_source' }
  }

  // Phase 2 — upload artifact
  emit({ type: 'uploading', sourceId })
  let version: number
  let artifactId: string
  try {
    const result = await apiUploadArtifact(baseUrl, bearer, sourceId, artifact, mergeMode)
    version = result.version
    artifactId = result.artifactId
    emit({ type: 'uploaded', sourceId, version, artifactId })
  } catch (err) {
    const error = (err as Error).message
    emit({ type: 'failed', error })
    return { ok: false, error, step: 'upload' }
  }

  // Phase 3 — persist binding (only if newly created or re-bound; skip
  // for reused bindings since the file is already correct).
  if (isNewSource) {
    try {
      const binding: SourceBinding = {
        sourceId,
        name: sourceName,
        workspaceId,
        createdAt: new Date().toISOString(),
      }
      writeBinding(cwd, binding)
      emit({ type: 'binding_written', path: bindingPath(cwd) })
    } catch (err) {
      // Non-fatal: the upload succeeded. We surface a warning but don't
      // call the whole flow failed. The user can re-bind manually.
      const error = `binding write failed: ${(err as Error).message}`
      emit({ type: 'failed', error })
      return { ok: false, error, step: 'persist_binding' }
    }
  }

  return {
    ok: true,
    sourceId,
    sourceName,
    version,
    artifactId,
    viewUrl: `${appBaseUrl.replace(/\/+$/, '')}/knowledge-sources/${encodeURIComponent(sourceId)}`,
    bindingPath: bindingPath(cwd),
    isNewSource,
  }
}

async function createSource(
  baseUrl: string,
  bearer: string,
  name: string,
  repoOrigin: string | undefined,
): Promise<{ id: string; name: string }> {
  const res = await createCliSource(baseUrl, bearer, { name, repoOrigin })
  return { id: res.source.id, name: res.source.name }
}
