import { useAppStore } from '@/store'
import {
  canAutoSaveOpenFile,
  isExternalReloadableEditorTab
} from '@/components/editor/editor-autosave'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import { scheduleDebouncedEditorExternalReload } from './editor-external-watch-disk-verification'

/**
 * A narrow watch only sees open files' own directories and can miss a
 * replaced directory, so when the workspace regains its full-tree watch every
 * tab is re-checked against disk. Dirty tabs go through the restored-tab
 * conflict scan (autosave stays suspended until it resolves); clean tabs reload.
 */
export function reverifyEditorTabsAfterNarrowWatch(target: EditorExternalWatchTarget): void {
  const state = useAppStore.getState()
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== target.runtimeEnvironmentId
    ) {
      continue
    }
    if (!file.isDirty) {
      // Why: a deleted/renamed tombstone is already a disk verdict; reloading would discard it.
      if (isExternalReloadableEditorTab(file) && !file.externalMutation) {
        scheduleDebouncedEditorExternalReload({
          worktreeId: target.worktreeId,
          worktreePath: target.worktreePath,
          relativePath: file.relativePath,
          runtimeEnvironmentId: target.runtimeEnvironmentId,
          ...getLocalWindowsWslAliasOption(target)
        })
      }
      continue
    }
    // Why: mirror the scan's eligibility, or a tab it skips would keep autosave suspended forever.
    if (
      file.lastKnownDiskSignature &&
      file.externalMutation !== 'changed' &&
      canAutoSaveOpenFile(file)
    ) {
      state.setPendingDiskBaselineVerification(file.id, true)
    }
  }
}
