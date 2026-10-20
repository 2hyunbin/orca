/**
 * One freshness counter per buffer record, shared by every panel showing the file. A disk read
 * may publish only if nothing newer (a later read, a save, a reload) started since it began, so
 * an older read can never land over newer text or newer disk bytes in any panel.
 */
const freshnessByRecord = new Map<string, number>()

export function markEditorBufferNewer(recordId: string): number {
  const next = (freshnessByRecord.get(recordId) ?? 0) + 1
  freshnessByRecord.set(recordId, next)
  return next
}

/** Starting a read supersedes every read of the record that started before it. */
export function beginEditorBufferRead(recordId: string): number {
  return markEditorBufferNewer(recordId)
}

export function isEditorBufferReadCurrent(recordId: string, token: number): boolean {
  return freshnessByRecord.get(recordId) === token
}
