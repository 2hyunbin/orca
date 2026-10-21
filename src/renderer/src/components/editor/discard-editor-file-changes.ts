import { useAppStore } from '@/store'
import { isLastEditorBufferView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { requestEditorSaveQuiesce } from './editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'

/** Drops the unsaved edits `fileId` shows, unless another view still holds its record. */
export async function discardEditorBuffer(fileId: string): Promise<void> {
  if (!isLastEditorBufferView(useAppStore.getState(), fileId)) {
    return
  }
  // Why: flush first so a debounced rich edit can't re-dirty the tab after it is cleared.
  try {
    flushPendingEditorBuffer(useAppStore.getState(), fileId)
  } catch (error) {
    console.warn('Pending edit flush failed before discard', error)
  }
  const state = useAppStore.getState()
  // Why: clean before draining, so queued or not-yet-writing saves find nothing to write.
  state.markFileDirty(fileId, false)
  // Why: a leftover draft makes closeFile keep a never-saved untitled placeholder on disk.
  state.clearEditorDraft(fileId)
  try {
    await requestEditorSaveQuiesce({ fileId })
  } catch (error) {
    console.warn('Autosave settle failed before discard', error)
  }
}

/** "Don't Save": drop unsaved edits, let saves already writing finish, then close the tab. */
export async function discardEditorFileChangesAndClose(fileId: string): Promise<void> {
  await discardEditorBuffer(fileId)
  useAppStore.getState().closeFile(fileId)
}
