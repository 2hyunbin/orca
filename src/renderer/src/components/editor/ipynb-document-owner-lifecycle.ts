import { getEditorModelOwnerKey } from './editor-model-owner'
import { registerEditorBufferOwner } from './editor-buffer-owners'
import { getSession, runningCellKey, store, updateSession } from './ipynb-kernel-store'
import { useAppStore } from '@/store'
import type { Entry } from './ipynb-document-store'

type AppState = ReturnType<typeof useAppStore.getState>

const DRAFT_WRITE_DELAY_MS = 400

export function runningNotebookKeys(fileId: string): string[] {
  const filePath = useAppStore.getState().openFiles.find((file) => file.id === fileId)?.filePath
  const session = filePath === undefined ? null : getSession(filePath)
  const key = session ? runningCellKey(session) : null
  return key !== null && session?.runs[key]?.fileId === fileId ? [key] : []
}

export function clearNotebookSourceTimer(entry: Entry): void {
  if (entry.writeTimer !== null) {
    clearTimeout(entry.writeTimer)
    entry.writeTimer = null
  }
}

export function scheduleNotebookSourceWrite(entry: Entry, write: (entry: Entry) => void): void {
  clearNotebookSourceTimer(entry)
  entry.writeTimer = setTimeout(() => write(entry), DRAFT_WRITE_DELAY_MS)
}

export function clearNotebookTimers(entry: Entry): void {
  clearNotebookSourceTimer(entry)
  if (entry.completionTimer !== null) {
    clearTimeout(entry.completionTimer)
    entry.completionTimer = null
  }
}

export function scheduleNotebookCompletion(
  entry: Entry,
  entries: Map<string, Entry>,
  write: (entry: Entry) => void
): void {
  if (entry.completionTimer !== null) {
    return
  }
  entry.completionTimer = setTimeout(() => {
    entry.completionTimer = null
    if (entries.get(entry.fileId) === entry) {
      write(entry)
    }
  }, 400)
}

export function registerNotebookOwner(
  entry: Entry,
  write: (entry: Entry) => void,
  cancelReload: (entry: Entry) => void
): () => void {
  return registerEditorBufferOwner(entry.fileId, {
    flush: () => write(entry),
    hasChange: () => entry.view.document !== null && entry.version !== entry.baseVersion,
    version: () => entry.version,
    discard: () => cancelReload(entry),
    cancelDiscard: () => cancelReload(entry)
  })
}

/** Transfer the one live model only across an exact, same-owner reparent. */
export function migrateNotebookOwner(
  fileId: string,
  entry: Entry,
  entries: Map<string, Entry>,
  state: AppState,
  previous: AppState,
  cancelReload: (entry: Entry) => void,
  write: (entry: Entry) => void
): boolean {
  const source = previous.openFiles.find((file) => file.id === fileId)
  const target = source?.pendingOwnerMigration
    ? state.openFiles.find(
        (file) =>
          file.filePath === source.filePath &&
          !previous.openFiles.some((old) => old.id === file.id) &&
          getEditorModelOwnerKey(source, previous) === getEditorModelOwnerKey(file, state)
      )
    : undefined
  if (!source || !target || entries.has(target.id)) {
    return false
  }
  cancelReload(entry)
  entry.unregister()
  entries.delete(fileId)
  entry.fileId = target.id
  entry.unregister = registerNotebookOwner(entry, write, cancelReload)
  entries.set(target.id, entry)
  if (store.getState().sessions[source.filePath]) {
    updateSession(source.filePath, ({ queue, runs }) => ({
      queue: queue.map((cell) => (cell.fileId === fileId ? { ...cell, fileId: target.id } : cell)),
      runs: Object.fromEntries(
        Object.entries(runs).map(([key, run]) => [
          key,
          run.fileId === fileId ? { ...run, fileId: target.id } : run
        ])
      )
    }))
  }
  return true
}
