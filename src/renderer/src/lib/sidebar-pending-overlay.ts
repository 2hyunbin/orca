import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import {
  buildPairedServerRows,
  type PairedServerWorkspaceRow
} from '../../../shared/sidebar-list/paired-server-rows'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

// The row fields a sidebar drag, pin or rename writes, named alike in metadata and main's rows.
export const ROW_WRITE_FIELDS = [
  'manualOrder',
  'workspaceStatus',
  'isPinned',
  'isArchived',
  'isUnread',
  'displayName'
] as const satisfies readonly (keyof WorktreeMeta &
  keyof WorkspaceRow &
  keyof PairedServerWorkspaceRow)[]

export type RowWriteField = (typeof ROW_WRITE_FIELDS)[number]
export type RowWriteValues = Partial<Pick<WorktreeMeta, RowWriteField>>

export type PendingRow = {
  /** The operation it came from; answering and expiry find it by this, whatever it was trimmed to. */
  opId: number
  worktreeId: string
  /** Null: a local row whose metadata names no host, matched on every host. */
  hostId: ExecutionHostId | null
  /** The feed read sent once main answered; null while the operation runs. */
  answeredBy: number | null
}

export type PendingRowWrite = PendingRow & { values: RowWriteValues }

export type CreatedWorkspace = { worktree: Worktree } | { folderWorkspace: FolderWorkspace }

/** The window's own sidebar operations main's feed does not show yet. */
export type SidebarPendingLayer = {
  writes: readonly PendingRowWrite[]
  created: readonly (PendingRow & { workspace: CreatedWorkspace })[]
  removed: readonly PendingRow[]
}

export function targets(entry: PendingRow, id: string, hostId: ExecutionHostId | null): boolean {
  return entry.worktreeId === id && (entry.hostId === null || entry.hostId === hostId)
}

export function rowHostId(row: WorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(row.hostId)?.id ?? null
}

export function serverRowHostId(row: PairedServerWorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(getExecutionHostIdFromWorktreeHostIdentity(row.key))?.id ?? null
}

function withoutRemoved<Row>(
  rows: Map<string, Row>,
  removed: readonly PendingRow[],
  idOf: (row: Row) => [string, ExecutionHostId | null]
): void {
  for (const [key, row] of rows) {
    const [id, hostId] = idOf(row)
    if (removed.some((entry) => targets(entry, id, hostId))) {
      rows.delete(key)
    }
  }
}

function patch<Row extends Partial<Pick<WorkspaceRow, RowWriteField>>>(
  row: Row,
  id: string,
  hostId: ExecutionHostId | null,
  writes: readonly PendingRowWrite[]
): Row {
  let patched = row
  for (const write of writes) {
    if (targets(write, id, hostId)) {
      patched = { ...patched, ...write.values }
    }
  }
  return patched
}

function withMissing<Row>(
  rows: ReadonlyMap<string, Row>,
  added: ReadonlyMap<string, Row>
): Map<string, Row> {
  const merged = new Map(rows)
  for (const [key, row] of added) {
    if (!merged.has(key)) {
      merged.set(key, row)
    }
  }
  return merged
}

/** Main's inputs with the window's pending operations over them; the same object when none. */
export function overlaySidebarPendingLayer(
  domains: SidebarFeedDomains,
  pending: SidebarPendingLayer,
  catalog: { repos: readonly Repo[]; lineageById: Readonly<Record<string, WorktreeLineage>> }
): SidebarFeedDomains {
  const { writes, created, removed } = pending
  if (writes.length === 0 && created.length === 0 && removed.length === 0) {
    return domains
  }
  const createdCatalog = {
    ...catalog,
    worktrees: created.flatMap(({ workspace }) =>
      'worktree' in workspace ? [workspace.worktree] : []
    ),
    folderWorkspaces: created.flatMap(({ workspace }) =>
      'folderWorkspace' in workspace ? [workspace.folderWorkspace] : []
    )
  }
  const workspaces = withMissing(domains.workspaces, buildWorkspaceRows(createdCatalog))
  // Main lists a paired server's new row only once the server's own list reaches it.
  const pairedServerRows = withMissing(
    domains.pairedServerRows,
    buildPairedServerRows(createdCatalog)
  )
  const touched = new Set(writes.map((write) => write.worktreeId))
  for (const [identity, row] of workspaces) {
    if (touched.has(row.id)) {
      workspaces.set(identity, patch(row, row.id, rowHostId(row), writes))
    }
  }
  for (const [key, row] of pairedServerRows) {
    if (touched.has(row.worktreeId)) {
      pairedServerRows.set(key, patch(row, row.worktreeId, serverRowHostId(row), writes))
    }
  }
  withoutRemoved(workspaces, removed, (row) => [row.id, rowHostId(row)])
  withoutRemoved(pairedServerRows, removed, (row) => [row.worktreeId, serverRowHostId(row)])
  return { ...domains, workspaces, pairedServerRows }
}
