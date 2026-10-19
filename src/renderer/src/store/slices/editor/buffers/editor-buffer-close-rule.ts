import type { OpenFile } from '../types/open-file'
import { editorBufferViewIds, type EditorBufferIndex } from './editor-buffer-record'

type EditorBufferViewState = {
  openFiles: readonly OpenFile[]
  editorBufferIndex?: EditorBufferIndex
}

function canSave(file: OpenFile): boolean {
  return file.readOnly !== true && file.csvPreviewOnly !== true
}

/** Whether another open tab can still save `fileId`'s unsaved edits after it closes. */
export function hasOtherSavingEditorView(state: EditorBufferViewState, fileId: string): boolean {
  const others = new Set(editorBufferViewIds(state, fileId).slice(1))
  return others.size > 0 && state.openFiles.some((file) => others.has(file.id) && canSave(file))
}

/** Only the last tab that can save the file asks to save it; earlier closes keep the edits. */
export function needsSavePromptOnClose(state: EditorBufferViewState, fileId: string): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  return file?.isDirty === true && canSave(file) && !hasOtherSavingEditorView(state, fileId)
}
