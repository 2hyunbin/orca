import {
  editorBufferSiblingViewIds,
  type EditorBufferViewIndex
} from '@/store/slices/editor/buffers/editor-buffer-views'

type PendingEditor = { flush: () => void; hasChange?: () => boolean }
const pendingEditorFlushes = new Map<string, Set<PendingEditor>>()

export function registerPendingEditorFlush(
  fileId: string,
  flush: () => void,
  hasChange?: () => boolean
): () => void {
  const entry = { flush, hasChange }
  const entries = pendingEditorFlushes.get(fileId) ?? new Set<PendingEditor>()
  entries.add(entry)
  pendingEditorFlushes.set(fileId, entries)
  return () => {
    entries.delete(entry)
    if (!entries.size && pendingEditorFlushes.get(fileId) === entries) {
      pendingEditorFlushes.delete(fileId)
    }
  }
}

function pendingEntriesOf(viewIds: readonly string[]): PendingEditor[] {
  return viewIds.flatMap((viewId) => [...(pendingEditorFlushes.get(viewId) ?? [])])
}

function flushPendingEntries(entries: PendingEditor[], autosave: boolean): void {
  // Keep legacy replacement semantics while retaining each CSV pane's pending input.
  const legacy = entries.findLast((entry) => !entry.hasChange)
  for (const entry of entries) {
    if (entry.hasChange ? !autosave : entry === legacy) {
      entry.flush()
    }
  }
}

/** Flushes pending text from every view of `fileId`'s record. */
export function flushPendingEditorBuffer(
  state: EditorBufferViewIndex,
  fileId: string,
  autosave = false
): void {
  flushPendingEntries(pendingEntriesOf(editorBufferSiblingViewIds(state, fileId)), autosave)
}

export function hasPendingEditorBufferChange(
  state: EditorBufferViewIndex,
  fileId: string
): boolean {
  return pendingEntriesOf(editorBufferSiblingViewIds(state, fileId)).some((entry) =>
    entry.hasChange?.()
  )
}

/**
 * Before a purge: commits every mounted view's pending text, so closed tabs' drafts are current.
 * A CSV cell commits only when it holds a change, leaving other workspaces' idle cells open.
 */
export function flushAllPendingEditorBuffers(): void {
  for (const entries of pendingEditorFlushes.values()) {
    const legacy = Array.from(entries).findLast((entry) => !entry.hasChange)
    for (const entry of entries) {
      try {
        if (entry.hasChange ? entry.hasChange() : entry === legacy) {
          entry.flush()
        }
      } catch (error) {
        // Why: one view failing to flush must not block the purge that asked.
        console.error('[editor] flushing pending edits before a purge failed', error)
      }
    }
  }
}
