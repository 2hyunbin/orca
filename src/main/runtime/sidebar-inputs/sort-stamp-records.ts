import {
  getRepoExecutionHostId,
  isRemoteExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type {
  SmartStampFields,
  SmartTier,
  SortStamps
} from '../../../shared/sidebar-list/sort-stamps'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

type StampedRecord = { lastActivityAt: number } & SmartStampFields
type StampUpdates = {
  lastActivityAt: number
  smartTier: SmartTier | undefined
  smartAt: number | undefined
}

/** The record reads and writes stamping needs, which the runtime's store satisfies. */
export type SortStampsStore = {
  getWorktreeMeta: (worktreeId: string) => StampedRecord | undefined
  setWorktreeMeta: (worktreeId: string, updates: StampUpdates) => unknown
  getWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId
  ) => StampedRecord | undefined
  setWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId,
    updates: StampUpdates
  ) => unknown
  getFolderWorkspace?: (folderWorkspaceId: string) => StampedRecord | undefined
  updateFolderWorkspace?: (folderWorkspaceId: string, updates: StampUpdates) => unknown
  getAllWorktreeMeta?: () => Record<string, StampedRecord & { hostId?: string }>
  getFolderWorkspaces?: () => readonly (StampedRecord & {
    id: string
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  getRepo?: (repoId: string) => Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
}

/** A workspace record: its id, and the SSH host whose record it is (null reads by id alone). */
export type WorkspaceRef = { worktreeId: string; sshHostId: ExecutionHostId | null }

// Only a workspace with a record is stamped; writing would create one for a stale id.
export function readSortStamps(
  store: SortStampsStore | null,
  { worktreeId, sshHostId }: WorkspaceRef
): SortStamps | null {
  const scope = parseWorkspaceKey(worktreeId)
  const record =
    scope?.type === 'folder'
      ? store?.getFolderWorkspace?.(scope.folderWorkspaceId)
      : sshHostId
        ? store?.getWorktreeMetaForHost?.(worktreeId, sshHostId)
        : store?.getWorktreeMeta(worktreeId)
  if (!record) {
    return null
  }
  return {
    recentAt: record.lastActivityAt,
    ...(record.smartTier !== undefined
      ? { smartTier: record.smartTier, smartAt: record.smartAt }
      : {})
  }
}

export function writeSortStamps(
  store: SortStampsStore | null,
  { worktreeId, sshHostId }: WorkspaceRef,
  stamps: SortStamps
): void {
  // Both tier keys are always written, so Rest clears them.
  const updates: StampUpdates = {
    lastActivityAt: stamps.recentAt,
    smartTier: stamps.smartTier,
    smartAt: stamps.smartAt
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    store?.updateFolderWorkspace?.(scope.folderWorkspaceId, updates)
  } else if (sshHostId) {
    store?.setWorktreeMetaForHost?.(worktreeId, sshHostId, updates)
  } else {
    store?.setWorktreeMeta(worktreeId, updates)
  }
}

/**
 * Workspaces of this machine whose record holds a tier. Another host's records are left out: a
 * host not reached yet is not one whose agents died.
 */
export function listThisMachineTieredWorkspaces(store: SortStampsStore | null): string[] {
  const ids: string[] = []
  for (const [worktreeId, meta] of Object.entries(store?.getAllWorktreeMeta?.() ?? {})) {
    const repo = store?.getRepo?.(getRepoIdFromWorktreeId(worktreeId))
    const hostId = meta.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
    if (meta.smartTier !== undefined && !isRemoteExecutionHostId(hostId)) {
      ids.push(worktreeId)
    }
  }
  for (const folder of store?.getFolderWorkspaces?.() ?? []) {
    if (
      folder.smartTier !== undefined &&
      !folder.connectionId &&
      !isRemoteExecutionHostId(folder.executionHostId)
    ) {
      ids.push(folderWorkspaceKey(folder.id))
    }
  }
  return ids
}
