import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { isEditorModelDirty, isWholeEditorState } from './editor-save-disk-precondition'

/**
 * A clean tab's text (cache, or a leftover draft) that no longer matches its disk version, such as
 * a cache kept across another tab's write. It must never be pushed into a live model.
 */
export function isStaleCachedEditorText(fileId: string, content: string): boolean {
  const state = useAppStore.getState()
  const file = state?.openFiles?.find((openFile) => openFile.id === fileId)
  if (!file || file.isDirty || file.mode !== 'edit') {
    return false
  }
  const baseline = file.lastKnownDiskSignature
  return baseline !== undefined && getDiskBaselineSignature(content) !== baseline
}

const requestedReloads = new Map<string, string>()

/** Drops a stale cache so it reloads from disk, once per cached text: a reload that lands the same text can't loop. */
export function requestStaleCacheReload(fileId: string, content: string): void {
  const signature = getDiskBaselineSignature(content)
  if (requestedReloads.get(fileId) === signature) {
    return
  }
  requestedReloads.set(fileId, signature)
  notifyEditorFileCacheStale(fileId)
}

/**
 * The one rule for pushing a tab's text into its live model: a clean tab's text (disk-derived, or a
 * leftover draft) never enters a dirty model. Reload and Overwrite clear the model's edits first.
 */
export function mayPushTabTextIntoModel(fileId: string): boolean {
  const state = useAppStore.getState()
  if (!isWholeEditorState(state)) {
    return true
  }
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (!file || file.isDirty) {
    // Why: a dirty tab's text is its own edits.
    return true
  }
  // Why backstop: a clean tab's leftover draft is never restored into the model, whatever its state.
  if (state.editorDrafts[fileId] !== undefined) {
    return false
  }
  return !isEditorModelDirty(state, file)
}
