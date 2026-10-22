import {
  resolveQualifiedFolderWorkspace,
  resolveQualifiedFolderWorkspaceResult
} from '../../../../shared/folder-workspace-execution-host'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { stat } from 'node:fs/promises'
import type { Store } from '../../../persistence'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  resolveTerminalStartupCwdForWorkspace,
  type TerminalStartupCwdMissingDirFallback
} from '../../../../shared/terminal-startup-cwd'
import {
  assertFolderWorkspacePathUsable,
  getResolvedFolderWorkspacePathStatus
} from '../../../project-groups/folder-workspace-path-status'
import {
  isWslMoveWorkspaceBlocked,
  WslMoveProjectFencedError
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { listLiveDaemonPtyIds } from '../../../daemon/daemon-provider-state'

/**
 * A new PTY needs a workspace no WSL move is taking, and a folder that still exists. Reattaching to
 * a session the daemon still runs is not a new PTY: a reload mid-move must not orphan a live pane.
 */
export function assertWorkspaceAcceptsNewPty(
  store: Store | undefined,
  worktreeId: string | undefined,
  sessionId?: string,
  connectionId?: string | null
): Promise<void> | void {
  if (isWslMoveWorkspaceBlocked(store, worktreeId)) {
    return assertReattachesLiveSession(sessionId).then(() =>
      assertFolderWorkspacePtyPathUsable(store, worktreeId, connectionId)
    )
  }
  return assertFolderWorkspacePtyPathUsable(store, worktreeId, connectionId)
}

async function assertReattachesLiveSession(sessionId: string | undefined): Promise<void> {
  // An unanswered census is never proof the session lives, so it refuses.
  const live = sessionId ? await listLiveDaemonPtyIds() : null
  if (!sessionId || !live?.includes(sessionId)) {
    throw new WslMoveProjectFencedError()
  }
}

export function assertFolderWorkspacePtyPathUsable(
  store: Store | undefined,
  worktreeId: string | undefined,
  connectionId?: string | null
): Promise<void> | void {
  const workspaceScope = typeof worktreeId === 'string' ? parseWorkspaceKey(worktreeId) : null
  if (!store || workspaceScope?.type !== 'folder') {
    return
  }
  const selected = resolveSpawnFolder(store, workspaceScope.folderWorkspaceId, connectionId)
  return getResolvedFolderWorkspacePathStatus(selected.workspace, selected.hostId).then(
    assertFolderWorkspacePathUsable
  )
}

export function resolvePtySpawnStartupCwd(
  store: Store | undefined,
  worktreeId: string | undefined,
  cwd: string | undefined,
  missingDirFallback?: TerminalStartupCwdMissingDirFallback,
  connectionId?: string | null
): string | undefined {
  return resolveTerminalStartupCwdForWorkspace({
    workspaceId: worktreeId,
    requestedCwd: cwd,
    missingDirFallback,
    resolveFolderWorkspacePath: (folderWorkspaceId) =>
      store
        ? (() => {
            const result = resolveQualifiedFolderWorkspaceResult(
              {
                folderWorkspaces: store.getFolderWorkspaces(),
                projectGroups: store.getProjectGroups(),
                repos: store.getRepos()
              },
              folderWorkspaceId,
              getConnectionExecutionHostId(connectionId)
            )
            return result.kind === 'selected' ? result.value.workspace.folderPath : undefined
          })()
        : undefined
  })
}

function resolveSpawnFolder(store: Store, id: string, connectionId?: string | null) {
  return resolveQualifiedFolderWorkspace(
    {
      folderWorkspaces: store.getFolderWorkspaces(),
      projectGroups: store.getProjectGroups(),
      repos: store.getRepos()
    },
    id,
    getConnectionExecutionHostId(connectionId)
  )
}

export async function localStartupCwdDirectoryExists(path: string): Promise<boolean> {
  // Why: Win32 stat on \\wsl.localhost 9P shares can falsely report ENOENT; defer to the provider's WSL-aware validation.
  if (isWslUncPath(path)) {
    return true
  }
  // Why async: a statSync on a dead network mount would freeze the whole main process.
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
