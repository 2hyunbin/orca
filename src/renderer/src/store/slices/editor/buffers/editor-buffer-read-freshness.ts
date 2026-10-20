import { editorBufferIdOf, type EditorBufferIndex } from './editor-buffer-record'

/**
 * One freshness counter per buffer record (one record per file), shared by every panel showing
 * it. A disk read may publish only if nothing newer (a later read, a write, an invalidation
 * of an in-flight read) started since it began.
 */
const freshnessByFile = new Map<string, number>()

export function editorBufferFreshnessKeyOf(
  state: { editorBufferIndex?: EditorBufferIndex },
  fileId: string
): string {
  return editorBufferIdOf(state, fileId)
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

/** For a read that must not supersede content reads (signature only): the counter as it stands. */
export function peekEditorBufferFreshness(fileKey: string): number {
  return freshnessByFile.get(fileKey) ?? 0
}

export function isEditorBufferReadCurrent(fileKey: string, token: number): boolean {
  return (freshnessByFile.get(fileKey) ?? 0) === token
}

/** Starts a content read of a tab's file, owned by its record rather than by the tab. */
export function beginEditorBufferFileRead(
  state: { editorBufferIndex?: EditorBufferIndex },
  fileId: string
): { recordId: string; isCurrent: () => boolean } {
  const recordId = editorBufferFreshnessKeyOf(state, fileId)
  const token = beginEditorBufferRead(recordId)
  return { recordId, isCurrent: () => isEditorBufferReadCurrent(recordId, token) }
}
