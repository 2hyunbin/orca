import type { OpenFile } from '../types/open-file'
import { editorBufferSiblingViewIds, type EditorBufferViewLookup } from './editor-buffer-views'

type CloseRuleState = { openFiles: readonly OpenFile[] } & EditorBufferViewLookup

/**
 * Whether closing `viewId` must ask to save: its record is dirty and no view outside the close
 * survives it. A batch (`closing`) prompts once per record, on the record's last view.
 */
export function needsSavePromptOnClose(
  state: CloseRuleState,
  viewId: string,
  closing?: ReadonlySet<string>
): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === viewId)
  if (file?.isDirty !== true) {
    return false
  }
  const viewIds = editorBufferSiblingViewIds(state, viewId)
  const survivors = viewIds.filter((id) => id !== viewId && !closing?.has(id))
  return survivors.length === 0 && (closing === undefined || viewIds.at(-1) === viewId)
}
