import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { getPluginFileOpeningPlan } from '@/lib/plugin-file-opening-plan'
import { detectLanguage } from '@/lib/language-detect'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { validateNewTabEntryAbsolutePath } from './tab-create-entry-path-validation'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'

function folderHasViewerOwner(state: AppState, worktreeId: string, hostId: string): boolean {
  const scope = parseWorkspaceKey(worktreeId)
  const host = parseExecutionHostId(hostId)
  if (scope?.type !== 'folder' || !host) {
    return false
  }
  const folder = findFolderWorkspaceOwner(state, scope.folderWorkspaceId, host.id)
  if (!folder) {
    return false
  }
  const group = findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, host.id)
  const pin = parseExecutionHostId(folder.executionHostId ?? group?.executionHostId)
  const connectionId = folder.connectionId?.trim() || group?.connectionId?.trim()
  return pin
    ? pin.id === host.id
    : Boolean(connectionId && toSshExecutionHostId(connectionId) === host.id)
}

export function absoluteTabEntryViewerOwner(state: AppState, worktreeId: string): string | null {
  if (!state.getKnownWorktreeById(worktreeId)) {
    return null
  }
  try {
    const provenance = captureEditorFileOperationProvenance(state, worktreeId, undefined, false)
    const route = assertEditorFileOperationCurrent(state, worktreeId, provenance)
    return route.executionHostId &&
      (provenance.ownershipProjection === 'explicit' ||
        folderHasViewerOwner(state, worktreeId, route.executionHostId)) &&
      route.executionHostId !== 'local'
      ? JSON.stringify(provenance)
      : null
  } catch {
    return null
  }
}

export function openAbsoluteTabEntryViewerFile(args: {
  filePath: string
  worktreeId: string
  groupId: string
  expectedOwner?: string
}): void {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  if (
    !worktree ||
    !args.expectedOwner ||
    absoluteTabEntryViewerOwner(state, args.worktreeId) !== args.expectedOwner
  ) {
    throw new Error('Reopen the file after its connection settles.')
  }
  const filePath = validateNewTabEntryAbsolutePath(
    args.filePath,
    isWindowsAbsolutePathLike(worktree.path) ? 'windows' : 'posix'
  )
  const provenance = captureEditorFileOperationProvenance(state, args.worktreeId, undefined, false)
  const route = assertEditorFileOperationCurrent(state, args.worktreeId, provenance)
  const plan = getPluginFileOpeningPlan(
    filePath,
    state.settings,
    usePluginFileViewerStore.getState()
  )
  // The host validates the selected handle; ordinary stat cannot authorize an outside file.
  state.openFile(
    {
      filePath,
      relativePath: filePath,
      worktreeId: args.worktreeId,
      language: detectLanguage(filePath),
      runtimeEnvironmentId: route.runtimeEnvironmentId,
      operationProvenance: provenance,
      pluginViewerUserSelectedFile: true,
      readOnly: true,
      mode: plan.kind === 'plugin' ? 'plugin-viewer' : 'file-opening',
      ...(plan.kind === 'plugin'
        ? { pluginViewer: { key: plan.viewer.key, sourceView: { readOnly: true } } }
        : {
            fileOpening: { readOnly: true },
            fileOpeningChoicePending: plan.kind !== 'loading'
          })
    },
    { preview: false, targetGroupId: args.groupId }
  )
}
