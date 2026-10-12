import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveExplicitWorktreeOperationRouteResult } from '../lib/worktree-operation-catalog-route'
import { resolveStrictWorktreeOperationRouteResultForHost } from '../lib/worktree-operation-route'
import type {
  WorktreeOperationRouteResolution,
  WorktreeOperationRouteState
} from '../lib/worktree-operation-route'
import { getExplicitRuntimeEnvironmentIdForFolderWorkspace } from '../lib/folder-workspace-runtime-owner'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '../lib/worktree-runtime-owner-index'
import { routeForOwner } from '../lib/worktree-owner-route'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import type { WebSessionIntentOwner } from './web-session-intent-owner'

function resolveSourceWorkspaceOwner(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  }
  const folder = findIndexedFolderWorkspaceOwner(state.folderWorkspaces, scope.folderWorkspaceId)
  if (!folder) {
    return state.folderWorkspaces?.some((row) => row.id === scope.folderWorkspaceId)
      ? { kind: 'ambiguous' }
      : { kind: 'missing' }
  }
  const group = findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
  if (!group && state.projectGroups?.some((row) => row.id === folder.projectGroupId)) {
    return { kind: 'ambiguous' }
  }
  const host = parseExecutionHostId(folder.executionHostId ?? group?.executionHostId)
  const connectionId = folder.connectionId?.trim() || group?.connectionId?.trim()
  const route = routeForOwner({
    hostId: host?.id ?? (connectionId ? toSshExecutionHostId(connectionId) : undefined),
    runtimeOwnerEnvironmentId:
      getExplicitRuntimeEnvironmentIdForFolderWorkspace(state, scope.folderWorkspaceId) ?? undefined
  })
  return route ? { kind: 'resolved', route } : { kind: 'missing' }
}

export function hostSessionTabSourceMatchesWorkspaceOwner(
  state: WorktreeOperationRouteState,
  owner: WebSessionIntentOwner,
  worktreeId: string
): boolean {
  const local = owner.environmentId === LOCAL_STRUCTURED_SESSION_OWNER
  const catalog = resolveSourceWorkspaceOwner(state, worktreeId)
  const host =
    state.activeWorktreeId === worktreeId
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  const selected = host
    ? catalog.kind === 'resolved' && catalog.route.executionHostId === host.id
      ? catalog
      : resolveStrictWorktreeOperationRouteResultForHost(state, worktreeId, host.id)
    : ({ kind: 'missing' } as const)
  // A catalog gap is silence; the captured pairing/generation remains the recovery fence.
  if (
    [catalog, selected].some(
      (resolution) =>
        resolution.kind === 'ambiguous' ||
        (resolution.kind === 'resolved' &&
          (local
            ? resolution.route.executionHostId !== 'local' ||
              resolution.route.runtimeEnvironmentId !== null
            : resolution.route.runtimeEnvironmentId !== owner.environmentId))
    )
  ) {
    return false
  }
  return true
}
