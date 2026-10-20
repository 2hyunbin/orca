import { useAppStore } from '@/store'
import {
  canAutoSaveOpenFile,
  isExternalReloadableEditorTab
} from '@/components/editor/editor-autosave'
import { forgetCombinedDiffViewBodiesForWorktree } from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'
import type { PathExistenceResult } from '../../../shared/path-existence-batch'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  scheduleDebouncedEditorExternalReload,
  type EditorExternalWatchNotification
} from './editor-external-watch-disk-verification'

type OverflowTarget = Pick<EditorExternalWatchTarget, 'worktreeId' | 'worktreePath'> &
  Partial<
    Pick<
      EditorExternalWatchTarget,
      'connectionId' | 'runtimeEnvironmentId' | 'allowLocalWindowsWslAliases'
    >
  >

type EditTabProbe = {
  fileId: string
  filePath: string
  runtimeEnvironmentId: string | null | undefined
  notification: EditorExternalWatchNotification
}

/**
 * An overflow (or a switch-back catch-up) names no paths, so every tab of the workspace may be stale.
 * Clean tabs reload unless disk proves the file gone; dirty tabs get the restored-tab disk check.
 */
export function reconcileEditorTabsAfterOverflow(target: OverflowTarget): void {
  // Why: unmounted combined-diff tabs get no per-path reload, so drop their cached bodies before a remount replays them.
  forgetCombinedDiffViewBodiesForWorktree(target.worktreeId)
  const state = useAppStore.getState()
  const probes: EditTabProbe[] = []
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file)
    ) {
      continue
    }
    if (file.isDirty) {
      // Why: a dirty tab is never reloaded; the restored-tab scan shows the changed-on-disk banner if disk moved.
      // Mirrors the scan's eligibility so it always resolves the flag.
      if (
        file.lastKnownDiskSignature &&
        file.externalMutation !== 'changed' &&
        canAutoSaveOpenFile(file)
      ) {
        state.setPendingDiskBaselineVerification(file.id, true)
      }
      continue
    }
    const notification: EditorExternalWatchNotification = {
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null,
      ...getLocalWindowsWslAliasOption(target)
    }
    if (file.mode !== 'edit') {
      if (file.externalMutation) {
        state.setExternalMutation(file.id, null)
      }
      scheduleDebouncedEditorExternalReload(notification)
      continue
    }
    probes.push({
      fileId: file.id,
      filePath: file.filePath,
      runtimeEnvironmentId: file.runtimeEnvironmentId,
      notification
    })
  }
  if (probes.length > 0) {
    void reloadEditTabsUnlessGone(target, probes)
  }
}

async function probeEditTabs(
  target: OverflowTarget,
  probes: readonly EditTabProbe[]
): Promise<readonly PathExistenceResult[] | null> {
  const owner = getRuntimeTargetForFileOwner(
    useAppStore.getState(),
    target.worktreeId,
    probes[0].runtimeEnvironmentId
  )
  if (!owner) {
    return null
  }
  try {
    return await runtimePathsExist(
      {
        target: owner,
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      },
      probes.map((probe) => probe.filePath)
    )
  } catch {
    // Why: a failed probe cannot prove absence; reload as before.
    return null
  }
}

// Why: reloading a file deleted while unwatched would swap the last content for a read error; mark it deleted as a watch event would.
async function reloadEditTabsUnlessGone(
  target: OverflowTarget,
  probes: readonly EditTabProbe[]
): Promise<void> {
  const results = await probeEditTabs(target, probes)
  const state = useAppStore.getState()
  probes.forEach((probe, index) => {
    const live = state.openFiles.find((file) => file.id === probe.fileId)
    if (!live || live.isDirty || live.mode !== 'edit') {
      return
    }
    const row = results?.[index]
    if (row && 'exists' in row && !row.exists) {
      // Why: keep a rename mark; without watch events a rename and a delete look the same.
      if (live.externalMutation !== 'deleted' && live.externalMutation !== 'renamed') {
        state.setExternalMutation(live.id, 'deleted')
      }
      return
    }
    if (live.externalMutation) {
      state.setExternalMutation(live.id, null)
    }
    scheduleDebouncedEditorExternalReload(probe.notification)
  })
}
