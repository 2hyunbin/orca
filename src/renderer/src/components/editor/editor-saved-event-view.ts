import type { OpenFile } from '@/store/slices/editor'

/**
 * An open view of the file a saved event reports. The saving view may have closed mid-write, so
 * the record's other views (`recordViewIds`) stand in for it.
 */
export function editorSavedEventView(
  openFiles: readonly OpenFile[],
  detail: unknown
): OpenFile | undefined {
  if (!detail || typeof detail !== 'object' || !('fileId' in detail)) {
    return undefined
  }
  const ids = new Set<unknown>([detail.fileId])
  if ('recordViewIds' in detail && Array.isArray(detail.recordViewIds)) {
    for (const id of detail.recordViewIds) {
      ids.add(id)
    }
  }
  return (
    openFiles.find((file) => file.id === detail.fileId) ??
    openFiles.find((file) => ids.has(file.id))
  )
}
