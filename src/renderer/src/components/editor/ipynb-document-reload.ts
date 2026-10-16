import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from './diff-content-signature'
import type { Entry } from './ipynb-document-store'

export type NotebookReload = {
  fileId: string
  keys: Set<string>
  onAccepted?: () => void
}

export function createNotebookReloadManager({
  getEntry,
  runningKeys,
  adopt,
  write
}: {
  getEntry: (fileId: string) => Entry | undefined
  runningKeys: (fileId: string) => string[]
  adopt: (entry: Entry, text: string, keys: string[]) => boolean
  write: (entry: Entry) => void
}) {
  const cancel = (entry: Entry): void => {
    if (entry.reload) {
      entry.reload = null
      entry.readEpoch += 1
    }
  }
  return {
    cancel,
    begin(fileId: string): NotebookReload | null {
      const entry = getEntry(fileId)
      if (!entry) {
        return null
      }
      cancel(entry)
      const reload = { fileId, keys: new Set(runningKeys(fileId)) }
      entry.reload = reload
      entry.readEpoch += 1
      return reload
    },
    epoch: (fileId: string): number => getEntry(fileId)?.readEpoch ?? 0,
    pending: (fileId: string): boolean => getEntry(fileId)?.reload != null,
    settle(reload: NotebookReload, text: string | null): boolean {
      const entry = getEntry(reload.fileId)
      if (!entry || entry.reload !== reload) {
        return false
      }
      cancel(entry)
      if (text === null || !adopt(entry, text, [...reload.keys])) {
        return true
      }
      const state = useAppStore.getState()
      state.clearEditorDraft(entry.fileId)
      state.setExternalMutation(entry.fileId, null)
      state.setLastKnownDiskSignature(entry.fileId, getDiskBaselineSignature(text))
      if (entry.version === entry.savedVersion) {
        state.markFileDirty(entry.fileId, false)
      } else {
        write(entry)
      }
      reload.onAccepted?.()
      return true
    }
  }
}
