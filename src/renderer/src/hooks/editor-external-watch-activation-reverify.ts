import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
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

function isTargetTab(file: OpenFile, target: EditorExternalWatchTarget): boolean {
  return (
    file.worktreeId === target.worktreeId &&
    getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId
  )
}

// Why: a narrow watch can miss a replaced directory, so dirty tabs re-check through the restored-tab conflict scan, which suspends autosave until it resolves.
export function armEditorTabDiskVerification(target: EditorExternalWatchTarget): void {
  const state = useAppStore.getState()
  for (const file of state.openFiles) {
    // Why: mirror the scan's eligibility, or a tab it skips would keep autosave suspended forever.
    if (
      isTargetTab(file, target) &&
      file.isDirty &&
      file.lastKnownDiskSignature &&
      file.externalMutation !== 'changed' &&
      canAutoSaveOpenFile(file)
    ) {
      state.setPendingDiskBaselineVerification(file.id, true)
    }
  }
}

// Why: same gap for clean tabs; a deleted/renamed tombstone is already a disk verdict, so it is left alone.
export function reloadCleanEditorTabs(target: EditorExternalWatchTarget): void {
  for (const file of useAppStore.getState().openFiles) {
    if (
      isTargetTab(file, target) &&
      !file.isDirty &&
      !file.externalMutation &&
      isExternalReloadableEditorTab(file)
    ) {
      scheduleDebouncedEditorExternalReload({
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        relativePath: file.relativePath,
        runtimeEnvironmentId: target.runtimeEnvironmentId,
        ...getLocalWindowsWslAliasOption(target)
      })
    }
  }
}
