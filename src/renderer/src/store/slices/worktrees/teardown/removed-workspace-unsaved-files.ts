import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import {
  collectRemovalUnsavedFiles,
  currentUnsavedText,
  lastViewUnsavedFiles,
  unsavedTextViewIds
} from '@/components/editor/removal-unsaved-editor-files'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../../../workspace-record-selectors'

/** Text retained only until the removal notice is dismissed or recovered. */
export type ClosedUnsavedFile = { fileId: string; filePath: string; content: string }

// Why text, not a flag: an edit made after the user confirmed is not what they agreed to discard.
const confirmedDiscards = new Map<string, string>()
let pendingNotice: { files: Map<string, ClosedUnsavedFile>; workspaces: Set<string> } | null = null

/** Records the exact text a removal dialog listed when the user confirmed discarding it. */
export function confirmUnsavedDiscard(
  getState: () => AppState,
  targets: readonly WorktreePurgeTarget[]
): void {
  const files = collectRemovalUnsavedFiles(getState, targets)
  const state = getState()
  const openIds = new Set((state.openFiles ?? []).map((file) => file.id))
  for (const id of confirmedDiscards.keys()) {
    if (!openIds.has(id)) {
      confirmedDiscards.delete(id)
    }
  }
  for (const file of files) {
    const text = currentUnsavedText(state, file)
    if (text !== undefined) {
      for (const id of unsavedTextViewIds(state, file)) {
        confirmedDiscards.set(id, text)
      }
    }
  }
}

function workspaceLabel(s: AppState, worktreeId: string): string {
  const worktree = Object.values(selectWorktreesByRepo(s) ?? {})
    .flat()
    .find((candidate) => candidate.id === worktreeId)
  const folder = (selectFolderWorkspaces(s) ?? []).find(
    (candidate) => folderWorkspaceKey(candidate.id) === worktreeId
  )
  return worktree?.displayName ?? folder?.name ?? worktreeId
}

/**
 * Captures the unsaved text of tabs a purge closes and offers it back. Runs inside purge updaters,
 * so one toast per microtask waits for the commit and merges every purge of the batch.
 */
export function noticeRemovedUnsavedFiles(s: AppState, removedFileIds: ReadonlySet<string>): void {
  try {
    for (const file of removedFileIds.size > 0 ? lastViewUnsavedFiles(s, removedFileIds) : []) {
      const content = currentUnsavedText(s, file)
      if (content === undefined) {
        console.warn('[editor] removed workspace closed a dirty tab with no text to recover', {
          filePath: file.filePath
        })
      } else if (confirmedDiscards.get(file.id) !== content) {
        queueNotice({ fileId: file.id, filePath: file.filePath, content }, s, file.worktreeId)
      } else {
        // Why deferred: a repeated purge of this batch must still see the confirmation.
        queueMicrotask(() => confirmedDiscards.delete(file.id))
      }
    }
  } catch (error) {
    console.error('[editor] capturing unsaved edits from a removed workspace failed', error)
  }
}

function queueNotice(file: ClosedUnsavedFile, s: AppState, worktreeId: string): void {
  if (!pendingNotice) {
    pendingNotice = { files: new Map(), workspaces: new Set() }
    queueMicrotask(showPendingNotice)
  }
  if (!pendingNotice.files.has(file.fileId)) {
    pendingNotice.files.set(file.fileId, file)
    pendingNotice.workspaces.add(workspaceLabel(s, worktreeId))
  }
}

function showPendingNotice(): void {
  const notice = pendingNotice
  pendingNotice = null
  if (!notice) {
    return
  }
  const closed = [...notice.files.values()]
  const label = [...notice.workspaces].join(', ')
  console.warn('[editor] removed workspace closed files with unsaved edits', {
    workspaces: label,
    filePaths: closed.map((file) => file.filePath)
  })
  // Why lazy: keeps toast and editor-open code out of the store's import graph.
  void import('@/components/editor/closed-unsaved-files-toast').then((module) =>
    module.showClosedUnsavedFilesToast(closed, label)
  )
}
