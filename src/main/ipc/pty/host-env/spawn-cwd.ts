import { statSync } from 'node:fs'
import type { Store } from '../../../persistence'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  resolveTerminalStartupCwdForWorkspace,
  type TerminalStartupCwdMissingDirFallback
} from '../../../../shared/terminal-startup-cwd'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus
} from '../../../project-groups/folder-workspace-path-status'
import { assertWslMoveWorkspaceWritable } from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'

/** A new PTY needs a workspace no WSL move is taking, and a folder that still exists. */
export function assertWorkspaceAcceptsNewPty(
  store: Store | undefined,
  worktreeId: string | undefined
): Promise<void> | void {
  if (store) {
    assertWslMoveWorkspaceWritable(store, worktreeId)
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId)
}

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  return getFolderWorkspacePathStatus(store, {
    scope: 'folder-workspace',
    folderWorkspaceId: workspaceScope.folderWorkspaceId
  }).then(assertFolderWorkspacePathUsable)
}

export function resolvePtySpawnStartupCwd(
  store: Store | undefined,
  worktreeId: string | undefined,
  cwd: string | undefined,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback
): string | undefined {
  return resolveTerminalStartupCwdForWorkspace({
    workspaceId: worktreeId,
    requestedCwd: cwd,
    missingDirFallback,
    resolveFolderWorkspacePath: (folderWorkspaceId) =>
      store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  })
}

export function localStartupCwdDirectoryExists(path: string): boolean {
  // Why: Win32 statSync on \\wsl.localhost 9P shares can falsely report ENOENT; defer to the provider's WSL-aware validation.
  if (isWslUncPath(path)) {
    return true
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
