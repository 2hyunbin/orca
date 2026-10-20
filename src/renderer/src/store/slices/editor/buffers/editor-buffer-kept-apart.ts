import type { AppState } from '@/store/types'
import { editorBufferIdOf } from './editor-buffer-record'
import { isSameEditorBuffer } from './editor-buffer-identity'

type KeptApartState = Pick<AppState, 'openFiles' | 'editorBufferIndex'>

/** Other live records of the same physical file: siblings kept apart by differing drafts. */
function siblingRecordIds(state: KeptApartState, recordId: string): string[] {
  const keys = state.editorBufferIndex?.keyByRecordId ?? {}
  const own = keys[recordId]
  if (own === undefined) {
    return []
  }
  return Object.entries(keys)
    .filter(([id, key]) => id !== recordId && isSameEditorBuffer(key.identity, own.identity))
    .map(([id]) => id)
}

/**
 * Why: a record kept apart from another record of its file can't rely on the self-write echo
 * filter to notice the other record's writes, so its saves must be compared on the host.
 */
export function isEditorBufferKeptApart(state: KeptApartState, recordId: string): boolean {
  return siblingRecordIds(state, recordId).length > 0
}

/** After a write, other dirty records of the same file hold edits against an older disk version. */
export function markKeptApartSiblingsChanged(
  state: KeptApartState & Pick<AppState, 'setExternalMutation'>,
  recordId: string
): void {
  const siblings = new Set(siblingRecordIds(state, recordId))
  if (siblings.size === 0) {
    return
  }
  for (const file of state.openFiles) {
    if (file.isDirty && siblings.has(editorBufferIdOf(state, file.id))) {
      state.setExternalMutation(file.id, 'changed')
    }
  }
}
