import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  findAmbiguousWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from '@/lib/unified-tab-host-ownership'

export function matchesRemovedWorktreeOwner(
  state: Pick<AppState, 'repos'>,
  row: Worktree,
  hostId: ExecutionHostId | undefined
): boolean {
  return (
    hostId === undefined ||
    row.hostId === hostId ||
    worktreeMatchesHost(row, hostId, worktreeHostMatchOptions(state, row.repoId, hostId))
  )
}

export function removedOwnerTabIds(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree'> &
    Partial<
      Pick<
        AppState,
        'worktreesByRepo' | 'browserTabsByWorktree' | 'restoredRuntimeHostIdByWorkspaceSessionKey'
      >
    >,
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): Set<string> {
  const rows = Object.values(state.worktreesByRepo ?? {}).flat()
  const ambiguous = findAmbiguousWorktreeIds(rows)
  const ids = new Set<string>()
  const unified = state.unifiedTabsByWorktree[worktreeId] ?? []
  for (const tab of unified) {
    if (
      hostId === undefined ||
      isUnifiedTabOwnedByWorktree(tab, { id: worktreeId, hostId }, ambiguous)
    ) {
      ids.add(tab.id)
      ids.add(tab.entityId)
    }
  }
  const restored =
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeId] ??
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeWorkspaceKey(worktreeId)]
  if (hostId === undefined || (restored ? restored === hostId : !ambiguous.has(worktreeId))) {
    for (const tab of [
      ...(state.tabsByWorktree[worktreeId] ?? []),
      ...(state.browserTabsByWorktree?.[worktreeId] ?? [])
    ]) {
      if (!unified.some((row) => row.entityId === tab.id)) {
        ids.add(tab.id)
      }
    }
  }
  return ids
}

export function removalActiveHost(
  state: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'> &
    Partial<Pick<AppState, 'restoredRuntimeHostIdByWorkspaceSessionKey'>>
): ExecutionHostId {
  const id = state.activeWorktreeId
  return (
    state.activeWorkspaceExecutionHostId ??
    (id
      ? (state.restoredRuntimeHostIdByWorkspaceSessionKey?.[id] ??
        state.restoredRuntimeHostIdByWorkspaceSessionKey?.[worktreeWorkspaceKey(id)])
      : undefined) ??
    'local'
  )
}
