import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  SmartStampFields,
  SmartTier,
  SortStamps
} from '../../../shared/sidebar-list/sort-stamps'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'

type StampedRecord = { lastActivityAt: number; isUnread?: boolean } & SmartStampFields
type StampUpdates =
  | { lastActivityAt: number; smartTier: SmartTier | undefined; smartAt: number | undefined }
  | { isUnread: boolean }

/** The record reads and writes the host's sidebar writers need; the runtime's store satisfies it. */
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
  getAllWorktreeMeta?: () => Record<string, StampedRecord>
  getFolderWorkspaces?: () => readonly (StampedRecord & { id: string })[]
}

/** A workspace record: its id, and the SSH host whose record it is (null reads by id alone). */
export type WorkspaceRef = { worktreeId: string; sshHostId: ExecutionHostId | null }

// Only a workspace with a record is written; writing would create one for a stale id.
function readWorkspaceRecord(
  store: SortStampsStore | null,
  { worktreeId, sshHostId }: WorkspaceRef
): StampedRecord | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? store?.getFolderWorkspace?.(scope.folderWorkspaceId)
    : sshHostId
      ? store?.getWorktreeMetaForHost?.(worktreeId, sshHostId)
      : store?.getWorktreeMeta(worktreeId)
}

function writeWorkspaceRecord(
  store: SortStampsStore | null,
  { worktreeId, sshHostId }: WorkspaceRef,
  updates: StampUpdates
): void {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    store?.updateFolderWorkspace?.(scope.folderWorkspaceId, updates)
  } else if (sshHostId) {
    store?.setWorktreeMetaForHost?.(worktreeId, sshHostId, updates)
  } else {
    store?.setWorktreeMeta(worktreeId, updates)
  }
}

/** Sets the workspace's unread flag; true when its record held the other value. */
export function writeUnreadFlag(
  store: SortStampsStore | null,
  workspace: WorkspaceRef,
  isUnread: boolean
): boolean {
  const record = readWorkspaceRecord(store, workspace)
  if (!record || Boolean(record.isUnread) === isUnread) {
    return false
  }
  writeWorkspaceRecord(store, workspace, { isUnread })
  return true
}

export function readSortStamps(
  store: SortStampsStore | null,
  workspace: WorkspaceRef
): SortStamps | null {
  const record = readWorkspaceRecord(store, workspace)
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
  workspace: WorkspaceRef,
  stamps: SortStamps
): void {
  // Both tier keys are always written, so Rest clears them.
  writeWorkspaceRecord(store, workspace, {
    lastActivityAt: stamps.recentAt,
    smartTier: stamps.smartTier,
    smartAt: stamps.smartAt
  })
}

/** Every workspace whose record holds a tier. */
export function listTieredWorkspaces(store: SortStampsStore | null): string[] {
  const ids: string[] = []
  for (const [worktreeId, meta] of Object.entries(store?.getAllWorktreeMeta?.() ?? {})) {
    if (meta.smartTier !== undefined) {
      ids.push(worktreeId)
    }
  }
  for (const folder of store?.getFolderWorkspaces?.() ?? []) {
    if (folder.smartTier !== undefined) {
      ids.push(folderWorkspaceKey(folder.id))
    }
  }
  return ids
}
