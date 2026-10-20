// Editor tab moves and renames in a layout-owner build (phase C4), which the window still draws
// first: main then records them under the window's ids. Main's copy reaches the window through
// frames. Opens, closes and promotions go to main first (editor-tab-open/close-through-layout-owner).

import type { Tab } from '../../../../../../shared/tab-types'
import type { EditorFileRename } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutEditorFile } from '../../../../../../shared/workspace-layout/workspace-layout-model'
import { recordLayoutApply } from '@/runtime/layout-apply-send'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { OpenFilePathRekey } from '../types/open-file-path-rekey'
import type { RestoredEditorOwnerResult } from '../types/restored-editor-owner'
import { isEditorTabContentType } from './editor-tab-content-type'

type EditorOwnerState = Parameters<typeof recordLayoutApply>[0] &
  Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'>

/** The preview tabs that show a file, which making the file permanent promotes. */
export function previewEditorTabsOf(
  tabsByWorktree: AppState['unifiedTabsByWorktree'],
  fileId: string,
  tabId?: string
): Tab[] {
  return Object.values(tabsByWorktree).flatMap((tabs) =>
    tabs.filter(
      (tab) =>
        tab.entityId === fileId &&
        tab.isPreview === true &&
        isEditorTabContentType(tab.contentType) &&
        (!tabId || tab.id === tabId)
    )
  )
}

/**
 * Restored editor tabs the window just moved to the workspace that owns their file (F42), read
 * off the store before and after the move. A re-own within one workspace is a rename in place;
 * main skips it for a paired server's tabs, whose layout it does not own.
 */
export function recordRestoredEditorMoveInLayoutOwner(
  before: EditorOwnerState,
  after: EditorOwnerState,
  source: Pick<OpenFile, 'id' | 'worktreeId'>,
  result: RestoredEditorOwnerResult
): void {
  const file = result.ok
    ? after.openFiles.find((candidate) => candidate.id === result.fileId)
    : undefined
  const targetWorktreeId = file?.worktreeId
  const sourceWorktreeId = source.worktreeId
  if (!file || !targetWorktreeId) {
    return
  }
  if (targetWorktreeId === sourceWorktreeId) {
    // A dependent preview makes an in-place re-own a collision, so the file is the only rename.
    recordRenamedEditorFilesInLayoutOwner(after, before.openFiles, [
      { oldFileId: source.id, newFileId: file.id }
    ])
    return
  }
  const editorTabs = (state: EditorOwnerState, worktreeId: string): Tab[] =>
    (state.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) =>
      isEditorTabContentType(tab.contentType)
    )
  const stayed = new Set(editorTabs(after, sourceWorktreeId).map((tab) => tab.id))
  const left = editorTabs(before, sourceWorktreeId).filter((tab) => !stayed.has(tab.id))
  const had = new Set(
    editorTabs(before, targetWorktreeId).map((tab) => `${tab.id}\0${tab.entityId}`)
  )
  // The window appends the moved tabs in their source order.
  const joined = editorTabs(after, targetWorktreeId).filter(
    (tab) => !had.has(`${tab.id}\0${tab.entityId}`)
  )
  const groupId = joined.at(-1)?.groupId
  if (!groupId || left.length !== joined.length) {
    return
  }
  recordLayoutApply(after, sourceWorktreeId, {
    type: 'moveTabToWorkspace',
    toWorkspace: targetWorktreeId,
    tabs: left.map((tab, index) => ({
      tabId: tab.id,
      newTabId: joined[index]!.id,
      newEntityId: joined[index]!.entityId
    })),
    groupId,
    ...(file.mode === 'edit' ? { file: restorableEditorFile(file) } : {})
  })
}

/** Open files the window just rekeyed for a rename or move on disk, one command per workspace. */
export function recordRenamedEditorFilesInLayoutOwner(
  state: EditorOwnerState,
  filesBefore: readonly OpenFile[],
  rekeys: readonly Pick<OpenFilePathRekey, 'oldFileId' | 'newFileId'>[]
): void {
  const before = new Map(filesBefore.map((file) => [file.id, file]))
  const after = new Map(state.openFiles.map((file) => [file.id, file]))
  const renamesByWorktree = new Map<string, EditorFileRename[]>()
  for (const { oldFileId, newFileId } of rekeys) {
    const old = before.get(oldFileId)
    const renamed = after.get(newFileId)
    if (!old || !renamed) {
      continue
    }
    const renames = renamesByWorktree.get(old.worktreeId) ?? []
    renamesByWorktree.set(old.worktreeId, renames)
    renames.push({
      fileId: oldFileId,
      newFileId,
      // Main keeps only edit-mode files' records, by path.
      ...(old.mode === 'edit'
        ? { record: { fromFilePath: old.filePath, file: restorableEditorFile(renamed) } }
        : {})
    })
  }
  for (const [worktreeId, renames] of renamesByWorktree) {
    recordLayoutApply(state, worktreeId, { type: 'renameEditorFiles', renames })
  }
}

/** The fields the window's session save keeps for an edit-mode file. */
export function restorableEditorFile(file: OpenFile): LayoutEditorFile {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    ...(file.runtimeEnvironmentId !== undefined
      ? { runtimeEnvironmentId: file.runtimeEnvironmentId }
      : {}),
    ...(file.externalSshTargetId ? { externalSshTargetId: file.externalSshTargetId } : {}),
    ...(file.readOnly === true ? { readOnly: true } : {}),
    ...(file.readOnly === true && file.liveTail === true ? { liveTail: true } : {})
  }
}
