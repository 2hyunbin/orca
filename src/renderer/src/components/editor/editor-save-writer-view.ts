import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'
import {
  editorBufferSiblingViewIds,
  editorBufferViewIds
} from '@/store/slices/editor/buffers/editor-buffer-views'
import type { EditorSaveTrigger } from './editor-save-disk-precondition'
import { canAutoSaveOpenFile } from './editor-autosave'

function hasCurrentProvenance(state: AppState, file: OpenFile): boolean {
  if (!file.operationProvenance) {
    return true
  }
  try {
    assertEditorFileOperationCurrent(state, file.worktreeId, file.operationProvenance)
    return true
  } catch {
    return false
  }
}

export function isEditorWritableView(view: OpenFile): boolean {
  return view.readOnly !== true && view.csvPreviewOnly !== true
}

/**
 * The view a save writes through. An explicit save uses the view that asked; autosave and restart
 * use the first writable view whose owner is still current (one opened before a reconnect isn't).
 */
export function editorSaveWriterView(
  state: AppState,
  fileId: string,
  trigger: EditorSaveTrigger
): OpenFile | null {
  const asked = state.openFiles.find((openFile) => openFile.id === fileId) ?? null
  if (trigger === 'user' || trigger === 'overwrite') {
    return asked
  }
  // Why: the record's first view may be a CSV preview or read-only; writing through it throws.
  const mayWrite = (view: OpenFile): boolean =>
    trigger === 'autosave' ? canAutoSaveOpenFile(view) : isEditorWritableView(view)
  for (const viewId of editorBufferSiblingViewIds(state, fileId)) {
    const view = state.openFiles.find((openFile) => openFile.id === viewId)
    if (view && mayWrite(view) && hasCurrentProvenance(state, view)) {
      return view
    }
  }
  // Why: restart keeps the asking view so its owner error explains the refusal.
  return trigger === 'autosave' ? null : asked
}

/**
 * `viewId` while it is open, else another open view of `recordId` that `accept`s: a save outlives
 * the tab that asked, but the record's other views still hold its text.
 */
export function liveEditorRecordView(
  state: AppState,
  viewId: string,
  recordId: string,
  accept: (view: OpenFile) => boolean = () => true
): OpenFile | null {
  const own = state.openFiles.find((openFile) => openFile.id === viewId)
  if (own) {
    return own
  }
  for (const id of editorBufferViewIds(state, recordId)) {
    const view = state.openFiles.find((openFile) => openFile.id === id)
    if (view && accept(view)) {
      return view
    }
  }
  return null
}
