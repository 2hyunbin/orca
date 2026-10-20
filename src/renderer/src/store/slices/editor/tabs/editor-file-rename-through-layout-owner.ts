// Open files renamed or moved on disk, in a layout-owner build: the window sends each workspace's
// renames under the ids the move coordinator picked, and the frame that shows main's rename
// rekeys the files' drafts, buffers and autosave gate in the same update. A refusal changes nothing.

import { sendLayoutApply } from '@/runtime/layout-apply-send'
import {
  expectContentRekey,
  framesShowTabRekeys,
  type TabRekey
} from '@/runtime/layout-owner-content-rekeys'
import type { EditorFileRename } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../../../types'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { OpenFile } from '../types/open-file'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from '../types/open-file-path-rekey'
import { isEditorTabContentType } from './editor-tab-content-type'
import { restorableEditorFile } from './editor-tab-layout-owner'
import { layoutEditorViewOfOpenFile } from './open-file-layout-view'

/** Main's renames: an edit-mode file's record moves from its old path; a view takes the new one. */
function renamesOf(
  rekeys: readonly OpenFilePathRekey[],
  before: ReadonlyMap<string, OpenFile>,
  after: ReadonlyMap<string, OpenFile>
): EditorFileRename[] {
  return rekeys.map(({ oldFileId, newFileId }) => {
    const old = before.get(oldFileId)!
    const renamed = after.get(newFileId)
    const view = renamed && layoutEditorViewOfOpenFile(renamed)
    return {
      fileId: oldFileId,
      newFileId,
      ...(old.mode === 'edit' && renamed
        ? { record: { fromFilePath: old.filePath, file: restorableEditorFile(renamed) } }
        : {}),
      ...(view ? { view } : {})
    }
  })
}

/** The workspace's editor tabs under their ids after the rename, as main renames them. */
function tabRekeysOf(
  state: AppState,
  worktreeId: string,
  rekeys: readonly OpenFilePathRekey[]
): TabRekey[] {
  const ids = new Map(rekeys.map((rekey) => [rekey.oldFileId, rekey.newFileId]))
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
    isEditorTabContentType(tab.contentType) && ids.has(tab.entityId)
      ? [
          {
            tabId: tab.id,
            entityId: tab.entityId,
            newTabId: ids.get(tab.id) ?? tab.id,
            newEntityId: ids.get(tab.entityId)!
          }
        ]
      : []
  )
}

/** Checks the rekey against the store as it is, then sends one rename per workspace. */
export function renameEditorFilesThroughLayoutOwner(
  set: EditorSet,
  get: EditorGet,
  rekeys: readonly OpenFilePathRekey[],
  moveOperationId: string | undefined,
  /** The window's pure rekey (rekey-open-files-action), passed in so neither module imports the other. */
  rekeyOpenFilesPatch: (
    state: AppState,
    rekeys: readonly OpenFilePathRekey[],
    moveOperationId: string | undefined
  ) => { ok: true; patch: Partial<AppState> } | Extract<RekeyOpenFilesResult, { ok: false }>
): RekeyOpenFilesResult {
  const state = get()
  const planned = rekeyOpenFilesPatch(state, rekeys, moveOperationId)
  if (!planned.ok) {
    return planned
  }
  const before = new Map(state.openFiles.map((file) => [file.id, file]))
  const after = new Map((planned.patch.openFiles ?? []).map((file) => [file.id, file]))
  // Each file's own workspace: the same path can be open in more than one.
  const byWorktree = new Map<string, OpenFilePathRekey[]>()
  for (const rekey of rekeys) {
    const worktreeId = before.get(rekey.oldFileId)!.worktreeId
    byWorktree.set(worktreeId, [...(byWorktree.get(worktreeId) ?? []), rekey])
  }
  for (const [worktreeId, own] of byWorktree) {
    const rekeyHere = (s: AppState): Partial<AppState> => {
      const next = rekeyOpenFilesPatch(s, own, moveOperationId)
      return next.ok ? next.patch : {}
    }
    const tabs = tabRekeysOf(state, worktreeId, own)
    const expected = expectContentRekey(
      // A file no tab shows changes no frame: main's answer rekeys it.
      {
        shows: (cache) => framesShowTabRekeys(cache, worktreeId, worktreeId, tabs),
        patch: rekeyHere
      },
      own.flatMap((rekey) => [rekey.oldFileId, rekey.newFileId])
    )
    const today = (): void => {
      expected.dropped()
      set(rekeyHere(get()))
    }
    const sent = sendLayoutApply(
      state,
      worktreeId,
      { type: 'renameEditorFiles', renames: renamesOf(own, before, after) },
      {
        apply: () => expected.applied((patch) => set(patch), get()),
        asToday: today,
        refused: () => expected.dropped()
      }
    )
    if (!sent) {
      today()
    }
  }
  return { ok: true }
}
