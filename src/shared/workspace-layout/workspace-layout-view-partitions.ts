// The desktop view's one record against the partitions that store it (design §1.4): each partition
// keeps its own workspaces' selection in today's fields and every partition keeps the global
// pointers, as the window's split save writes them today. Pure, so the runtime's read and write of
// the record cannot disagree.

import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { isWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { filterRecord } from './stored-record-fields'
import { emptyLayoutViewRecord, type LayoutViewRecord } from './workspace-layout-views'

/** The partition that stores a workspace's selection; null keeps it in the local one. */
export type ViewRecordOwners = {
  workspace: (key: string) => ExecutionHostId | null
  /** By terminal tab id (`entityId`). */
  terminalTab: (tabId: string) => ExecutionHostId | null
}

/** The part of the record one partition stores. */
export function desktopViewForPartition(
  record: LayoutViewRecord,
  hostId: ExecutionHostId,
  owners: ViewRecordOwners
): LayoutViewRecord {
  const stores = (owner: ExecutionHostId | null): boolean =>
    (owner ?? LOCAL_EXECUTION_HOST_ID) === hostId
  const inPartition = (key: string): boolean => stores(owners.workspace(key))
  return {
    ...record,
    activeFileIdByWorktree: filterRecord(record.activeFileIdByWorktree, inPartition),
    activeBrowserTabIdByWorktree: filterRecord(record.activeBrowserTabIdByWorktree, inPartition),
    activeTabTypeByWorktree: filterRecord(record.activeTabTypeByWorktree, inPartition),
    activeTabIdByWorktree: filterRecord(record.activeTabIdByWorktree, inPartition),
    activeGroupIdByWorktree: filterRecord(record.activeGroupIdByWorktree, inPartition),
    // A host-qualified visit key already names its host.
    lastVisitedAtByWorktreeId: filterRecord(record.lastVisitedAtByWorktreeId, (key) =>
      stores(
        isWorktreeHostIdentity(key)
          ? normalizeExecutionHostId(key.slice(0, key.indexOf('|')))
          : owners.workspace(key)
      )
    ),
    // Keyed by file, not workspace: kept whole in the local partition, which every read merges.
    markdownFrontmatterVisible:
      hostId === LOCAL_EXECUTION_HOST_ID ? record.markdownFrontmatterVisible : undefined,
    groups: filterRecord(record.groups, inPartition) ?? {},
    lastFocusedAt: filterRecord(record.lastFocusedAt, inPartition) ?? {},
    editorDrafts: filterRecord(record.editorDrafts, inPartition) ?? {},
    panes: filterRecord(record.panes, (tabId) => stores(owners.terminalTab(tabId))) ?? {}
  }
}

/** The one record from the partitions' parts: global pointers from the local partition. */
export function mergeDesktopViewParts(
  parts: ReadonlyMap<ExecutionHostId, Partial<LayoutViewRecord>>
): LayoutViewRecord {
  const all = [...parts.values()]
  const union = <T>(
    field: (part: Partial<LayoutViewRecord>) => Record<string, T> | undefined
  ): Record<string, T> => Object.assign({}, ...all.map(field))
  return {
    ...emptyLayoutViewRecord(),
    ...parts.get(LOCAL_EXECUTION_HOST_ID),
    activeFileIdByWorktree: union((part) => part.activeFileIdByWorktree),
    activeBrowserTabIdByWorktree: union((part) => part.activeBrowserTabIdByWorktree),
    activeTabTypeByWorktree: union((part) => part.activeTabTypeByWorktree),
    activeTabIdByWorktree: union((part) => part.activeTabIdByWorktree),
    activeGroupIdByWorktree: union((part) => part.activeGroupIdByWorktree),
    lastVisitedAtByWorktreeId: union((part) => part.lastVisitedAtByWorktreeId),
    markdownFrontmatterVisible: union((part) => part.markdownFrontmatterVisible),
    groups: union((part) => part.groups),
    lastFocusedAt: union((part) => part.lastFocusedAt),
    editorDrafts: union((part) => part.editorDrafts),
    panes: union((part) => part.panes)
  }
}
