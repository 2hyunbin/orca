import { editorBufferIdOf, type EditorBufferIndex } from './editor-buffer-record'

/**
 * One freshness counter per physical file (its identity key; a tab that can't share falls back to
 * its record), so records kept apart and every panel showing the file agree. A disk read may
 * publish only if nothing newer (a later read, a write, a reload, Keep My Edits, a rejoin)
 * started since it began.
 */
const freshnessByFile = new Map<string, number>()

export function editorBufferFreshnessKeyOf(
  state: { editorBufferIndex?: EditorBufferIndex },
  fileId: string
): string {
  const recordId = editorBufferIdOf(state, fileId)
  return state.editorBufferIndex?.keyByRecordId[recordId]?.identity.key ?? recordId
}

export function markEditorBufferNewer(fileKey: string): number {
  const next = (freshnessByFile.get(fileKey) ?? 0) + 1
  freshnessByFile.set(fileKey, next)
  return next
}

/** Starting a read supersedes every read of the file that started before it. */
export function beginEditorBufferRead(fileKey: string): number {
  return markEditorBufferNewer(fileKey)
}

export function isEditorBufferReadCurrent(fileKey: string, token: number): boolean {
  return freshnessByFile.get(fileKey) === token
}
