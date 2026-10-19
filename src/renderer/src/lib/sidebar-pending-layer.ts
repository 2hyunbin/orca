import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { Repo } from '../../../shared/repo-types'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import type { PairedServerWorkspaceRow } from '../../../shared/sidebar-list/paired-server-rows'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  onDesktopSidebarFeedInstalled,
  refreshDesktopSidebarFeed,
  type DesktopSidebarFeed
} from './desktop-sidebar-feed'

// The row fields a sidebar drag, pin or rename writes, named alike in metadata and main's rows.
const ROW_WRITE_FIELDS = [
  'manualOrder',
  'workspaceStatus',
  'isPinned',
  'isArchived',
  'isUnread',
  'displayName'
] as const satisfies readonly (keyof WorktreeMeta &
  keyof WorkspaceRow &
  keyof PairedServerWorkspaceRow)[]

type RowWriteField = (typeof ROW_WRITE_FIELDS)[number]
type RowWriteValues = Partial<Pick<WorktreeMeta, RowWriteField>>

// Bounds what main never shows (a paired server that dropped a write); main's value wins after.
const PENDING_LIMIT_MS = 10_000

type PendingRow = {
  worktreeId: string
  /** Null: every host's row with this id, as the write itself resolves it. */
  hostId: ExecutionHostId | null
  /** The feed read sent once main answered; null while the operation runs. */
  answeredBy: number | null
}

type PendingRowWrite = PendingRow & { values: RowWriteValues }

type CreatedWorkspace = { worktree: Worktree } | { folderWorkspace: FolderWorkspace }

/** The window's own sidebar operations main's feed does not show yet. */
export type SidebarPendingLayer = {
  writes: readonly PendingRowWrite[]
  created: readonly (PendingRow & { workspace: CreatedWorkspace })[]
}

export type SidebarRowWrite = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
  executionHostId?: ExecutionHostId
}

let layer: SidebarPendingLayer = { writes: [], created: [] }
const listeners = new Set<() => void>()
let detachSettlement: (() => void) | null = null

function publish(next: SidebarPendingLayer): void {
  layer = next
  listeners.forEach((listener) => listener())
}

function targets(entry: PendingRow, id: string, hostId: ExecutionHostId | null): boolean {
  return entry.worktreeId === id && (entry.hostId === null || entry.hostId === hostId)
}

function rowHostId(row: WorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(row.hostId)?.id ?? null
}

function serverRowHostId(row: PairedServerWorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(getExecutionHostIdFromWorktreeHostIdentity(row.key))?.id ?? null
}

function answered(entry: PendingRow, installed: DesktopSidebarFeed): boolean {
  return entry.answeredBy !== null && installed.readId >= entry.answeredBy
}

/**
 * Main answers a write to its own rows only after applying it, so a read sent after the answer
 * shows it. A paired server's row reaches main by the server's own change event, later, so that
 * write holds until main's row echoes it.
 */
function writeShown(write: PendingRowWrite, installed: DesktopSidebarFeed): boolean {
  return (
    answered(write, installed) &&
    [...installed.domains.pairedServerRows.values()].every(
      (row) =>
        !targets(write, row.worktreeId, serverRowHostId(row)) ||
        ROW_WRITE_FIELDS.every(
          (field) => !(field in write.values) || row[field] === write.values[field]
        )
    )
  )
}

/** Main announces a new workspace after it answers the create, so it holds until main lists it. */
function createdShown(created: PendingRow, installed: DesktopSidebarFeed): boolean {
  const { workspaces, pairedServerRows } = installed.domains
  return (
    answered(created, installed) &&
    ([...workspaces.values()].some((row) => targets(created, row.id, rowHostId(row))) ||
      [...pairedServerRows.values()].some((row) =>
        targets(created, row.worktreeId, serverRowHostId(row))
      ))
  )
}

function settle(installed: DesktopSidebarFeed): void {
  const writes = layer.writes.filter((write) => !writeShown(write, installed))
  const created = layer.created.filter((entry) => !createdShown(entry, installed))
  if (writes.length !== layer.writes.length || created.length !== layer.created.length) {
    publish({ writes, created })
  }
}

/** Marks `entries` answered and reads main again; drops whichever main still has not shown later. */
function answer<Entry extends PendingRow>(
  entries: readonly Entry[],
  pick: (pending: SidebarPendingLayer) => readonly Entry[],
  put: (pending: SidebarPendingLayer, next: readonly Entry[]) => SidebarPendingLayer
): void {
  const answeredBy = refreshDesktopSidebarFeed()
  const replaced = new Map(
    entries.map((entry): [Entry, Entry] => [entry, { ...entry, answeredBy }])
  )
  publish(
    put(
      layer,
      pick(layer).map((entry) => replaced.get(entry) ?? entry)
    )
  )
  setTimeout(() => {
    const expired = new Set(replaced.values())
    if (pick(layer).some((entry) => expired.has(entry))) {
      console.warn('[sidebar] main never showed a pending sidebar change; showing main’s value')
      publish(
        put(
          layer,
          pick(layer).filter((entry) => !expired.has(entry))
        )
      )
    }
  }, PENDING_LIMIT_MS)
}

function startSettling(): void {
  detachSettlement ??= onDesktopSidebarFeedInstalled(settle)
}

function copyField<Field extends RowWriteField>(
  to: RowWriteValues,
  from: RowWriteValues,
  field: Field
): void {
  to[field] = from[field]
}

function rowWriteValues(updates: Partial<WorktreeMeta>): RowWriteValues | null {
  const values: RowWriteValues = {}
  const fields = ROW_WRITE_FIELDS.filter((field) => field in updates)
  fields.forEach((field) => copyField(values, updates, field))
  return fields.length > 0 ? values : null
}

/**
 * Switch point. Shows the window's own row writes before main's feed has caught up: each is laid
 * over main's rows from its start until main shows it, so main's value wins afterwards whether
 * main took the write or not.
 */
export function withPendingSidebarRowWrites<T>(
  writes: readonly SidebarRowWrite[],
  operation: () => Promise<T>
): Promise<T> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return operation()
  }
  const added = writes.flatMap((write): PendingRowWrite[] => {
    const values = rowWriteValues(write.updates)
    const hostId = parseExecutionHostId(write.executionHostId)?.id ?? null
    return values ? [{ worktreeId: write.worktreeId, hostId, values, answeredBy: null }] : []
  })
  if (added.length === 0) {
    return operation()
  }
  startSettling()
  publish({ ...layer, writes: [...layer.writes, ...added] })
  const running = operation()
  const settleAdded = (): void =>
    answer(
      added,
      (pending) => pending.writes,
      (pending, next) => ({ ...pending, writes: next })
    )
  void running.then(settleAdded, settleAdded)
  return running
}

/** Switch point. Lists a workspace the window just created until main's feed lists it too. */
export function holdCreatedSidebarWorkspace(workspace: CreatedWorkspace): void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return
  }
  const [worktreeId, hostId] =
    'worktree' in workspace
      ? [workspace.worktree.id, workspace.worktree.hostId]
      : [
          folderWorkspaceKey(workspace.folderWorkspace.id),
          workspace.folderWorkspace.executionHostId
        ]
  const entry = {
    worktreeId,
    hostId: parseExecutionHostId(hostId)?.id ?? null,
    workspace,
    answeredBy: null
  }
  startSettling()
  publish({ ...layer, created: [...layer.created, entry] })
  answer(
    [entry],
    (pending) => pending.created,
    (pending, next) => ({ ...pending, created: next })
  )
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

/** Main's inputs with the window's pending operations over them; the same object when none. */
export function overlaySidebarPendingLayer(
  domains: SidebarFeedDomains,
  pending: SidebarPendingLayer,
  catalog: { repos: readonly Repo[]; lineageById: Readonly<Record<string, WorktreeLineage>> }
): SidebarFeedDomains {
  const { writes, created } = pending
  if (writes.length === 0 && created.length === 0) {
    return domains
  }
  const workspaces = new Map(domains.workspaces)
  const createdRows = buildWorkspaceRows({
    worktrees: created.flatMap(({ workspace }) =>
      'worktree' in workspace ? [workspace.worktree] : []
    ),
    folderWorkspaces: created.flatMap(({ workspace }) =>
      'folderWorkspace' in workspace ? [workspace.folderWorkspace] : []
    ),
    repos: catalog.repos,
    lineageById: catalog.lineageById
  })
  for (const [identity, row] of createdRows) {
    if (!workspaces.has(identity)) {
      workspaces.set(identity, row)
    }
  }
  const touched = new Set(writes.map((write) => write.worktreeId))
  for (const [identity, row] of workspaces) {
    if (touched.has(row.id)) {
      workspaces.set(identity, patch(row, row.id, rowHostId(row), writes))
    }
  }
  const pairedServerRows = new Map(domains.pairedServerRows)
  for (const [key, row] of pairedServerRows) {
    if (touched.has(row.worktreeId)) {
      pairedServerRows.set(key, patch(row, row.worktreeId, serverRowHostId(row), writes))
    }
  }
  return { ...domains, workspaces, pairedServerRows }
}

export function subscribeSidebarPendingLayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readSidebarPendingLayer(): SidebarPendingLayer {
  return layer
}
