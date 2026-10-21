import type { AppState } from '../../../types'
import {
  flushRemovalPendingEdits,
  lastViewUnsavedFiles
} from '@/components/editor/removal-unsaved-editor-files'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../../../workspace-record-selectors'

/** Set by a removal the user confirmed in a dialog that listed its unsaved files. */
export type RemovalUnsavedEditsOptions = {
  unsavedEditsConfirmed?: boolean
  unsavedNoticeHandled?: boolean
}

/** Text retained only until the removal notice is dismissed or recovered. */
export type ClosedUnsavedFile = {
  filePath: string
  worktreeId: string
  language: string
  content: string
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
 * Captures removed tabs' unsaved text and offers it back in one toast. Runs inside purge updaters,
 * so the toast waits for the commit. A confirmed removal discards instead.
 */
export function noticeRemovedUnsavedFiles(
  s: AppState,
  removedFileIds: ReadonlySet<string>,
  options?: RemovalUnsavedEditsOptions
): void {
  if (
    options?.unsavedEditsConfirmed ||
    options?.unsavedNoticeHandled ||
    removedFileIds.size === 0
  ) {
    return
  }
  announceClosedUnsavedFiles(s, captureRemovedUnsavedFiles(s, removedFileIds))
}

export function captureRemovedUnsavedFiles(
  s: AppState,
  removedFileIds: ReadonlySet<string>
): ClosedUnsavedFile[] {
  try {
    return captureRemovedText(s, removedFileIds)
  } catch (error) {
    console.error('[editor] capturing unsaved edits from a removed workspace failed', error)
    return []
  }
}

function captureRemovedText(s: AppState, removedFileIds: ReadonlySet<string>): ClosedUnsavedFile[] {
  const closed: ClosedUnsavedFile[] = []
  for (const file of lastViewUnsavedFiles(s, removedFileIds)) {
    const content = s.editorDrafts[file.id]
    if (content === undefined) {
      console.warn('[editor] removed workspace closed a dirty tab with no draft text', {
        filePath: file.filePath,
        worktreeId: file.worktreeId
      })
      continue
    }
    closed.push({
      filePath: file.filePath,
      worktreeId: file.worktreeId,
      language: file.language,
      content
    })
  }
  return closed
}

export function announceClosedUnsavedFiles(s: AppState, closed: ClosedUnsavedFile[]): void {
  if (closed.length === 0) {
    return
  }
  const label = [...new Set(closed.map((file) => workspaceLabel(s, file.worktreeId)))].join(', ')
  console.warn('[editor] removed workspace closed files with unsaved edits', {
    workspaces: label,
    filePaths: closed.map((file) => file.filePath)
  })
  // Why lazy: keeps toast and editor-open code out of the store's import graph.
  queueMicrotask(() => {
    void import('@/components/editor/closed-unsaved-files-toast').then((module) =>
      module.showClosedUnsavedFilesToast(closed, label)
    )
  })
}

/** Flushes delayed views of every tab in these workspaces before a purge drops them. */
export function flushWorkspacePendingEdits(state: AppState, worktreeIds: Iterable<string>): void {
  const ids = new Set(worktreeIds)
  flushRemovalPendingEdits(
    state,
    (state.openFiles ?? []).filter((file) => ids.has(file.worktreeId)).map((file) => file.id)
  )
}
