import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import {
  ROW_WRITE_FIELDS,
  rowHostId,
  serverRowHostId,
  targets,
  type CreatedWorkspace,
  type PendingRow,
  type PendingRowWrite,
  type RowWriteField,
  type RowWriteValues,
  type SidebarPendingLayer
} from './sidebar-pending-overlay'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getFolderWorkspaceWorktreeHostId } from '../../../shared/folder-workspace-worktree'
import {
  onDesktopSidebarFeedInstalled,
  refreshDesktopSidebarFeed,
  type DesktopSidebarFeed
} from './desktop-sidebar-feed'

export type { SidebarPendingLayer }

// Bounds what main never shows (a paired server that dropped a write); main's value wins after.
const PENDING_LIMIT_MS = 10_000

export type SidebarRowWrite = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
  executionHostId?: ExecutionHostId
}

let layer: SidebarPendingLayer = { writes: [], created: [], removed: [] }
let lastOpId = 0
const listeners = new Set<() => void>()
let detachSettlement: (() => void) | null = null

function publish(next: SidebarPendingLayer): void {
  layer = next
  listeners.forEach((listener) => listener())
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

function listed(entry: PendingRow, installed: DesktopSidebarFeed): boolean {
  const { workspaces, pairedServerRows } = installed.domains
  return (
    [...workspaces.values()].some((row) => targets(entry, row.id, rowHostId(row))) ||
    [...pairedServerRows.values()].some((row) =>
      targets(entry, row.worktreeId, serverRowHostId(row))
    )
  )
}

/** Main announces a new workspace after it answers the create, so it holds until main lists it. */
function createdShown(created: PendingRow, installed: DesktopSidebarFeed): boolean {
  return answered(created, installed) && listed(created, installed)
}

/** Main can list a removed row until its worktree re-scan lands, so it holds until main drops it. */
function removalShown(removed: PendingRow, installed: DesktopSidebarFeed): boolean {
  return answered(removed, installed) && !listed(removed, installed)
}

function settle(installed: DesktopSidebarFeed): void {
  const writes = layer.writes.filter((write) => !writeShown(write, installed))
  const created = layer.created.filter((entry) => !createdShown(entry, installed))
  const removed = layer.removed.filter((entry) => !removalShown(entry, installed))
  if (
    writes.length !== layer.writes.length ||
    created.length !== layer.created.length ||
    removed.length !== layer.removed.length
  ) {
    publish({ writes, created, removed })
  }
}

/** Marks operations answered and reads main again; drops whichever main still has not shown later. */
function answer<Entry extends PendingRow>(
  opIds: ReadonlySet<number>,
  pick: (pending: SidebarPendingLayer) => readonly Entry[],
  put: (pending: SidebarPendingLayer, next: readonly Entry[]) => SidebarPendingLayer
): void {
  const answeredBy = refreshDesktopSidebarFeed()
  const ours = (entry: Entry): boolean => opIds.has(entry.opId)
  publish(
    put(
      layer,
      pick(layer).map((entry) => (ours(entry) ? { ...entry, answeredBy } : entry))
    )
  )
  setTimeout(() => {
    if (pick(layer).some(ours)) {
      console.warn('[sidebar] main never showed a pending sidebar change; showing main’s value')
      publish(
        put(
          layer,
          pick(layer).filter((entry) => !ours(entry))
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

function pickRowFields(
  from: RowWriteValues,
  keep: (field: RowWriteField) => boolean
): RowWriteValues | null {
  const values: RowWriteValues = {}
  const fields = ROW_WRITE_FIELDS.filter((field) => field in from && keep(field))
  fields.forEach((field) => copyField(values, from, field))
  return fields.length > 0 ? values : null
}

/** Earlier writes give up the fields a newer write to the same row sets, so the newest shows. */
function supersede(
  writes: readonly PendingRowWrite[],
  newer: readonly PendingRowWrite[]
): PendingRowWrite[] {
  return writes.flatMap((write) => {
    const covered = newer.filter(
      (next) => next.worktreeId === write.worktreeId && next.hostId === write.hostId
    )
    if (covered.length === 0) {
      return [write]
    }
    const values = pickRowFields(write.values, (field) =>
      covered.every((next) => !(field in next.values))
    )
    return values ? [{ ...write, values }] : []
  })
}

/**
 * Switch point. Shows the window's own row writes before main's feed has caught up: each is laid
 * over main's rows from its start until main shows it, so main's value wins afterwards whether
 * main took the write or not.
 */
export function withPendingSidebarRowWrites<T>(
  readWrites: () => readonly SidebarRowWrite[],
  operation: () => Promise<T>
): Promise<T> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return operation()
  }
  const added = readWrites().flatMap((write): PendingRowWrite[] => {
    const values = pickRowFields(write.updates, () => true)
    const hostId = parseExecutionHostId(write.executionHostId)?.id ?? null
    return values
      ? [{ opId: ++lastOpId, worktreeId: write.worktreeId, hostId, values, answeredBy: null }]
      : []
  })
  if (added.length === 0) {
    return operation()
  }
  startSettling()
  publish({ ...layer, writes: [...supersede(layer.writes, added), ...added] })
  // A write that never answers stays shown, as the store keeps its own optimistic value.
  const running = operation()
  const opIds = new Set(added.map((write) => write.opId))
  const settleAdded = (): void =>
    answer(
      opIds,
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
  const [worktreeId, rawHostId] =
    'worktree' in workspace
      ? [workspace.worktree.id, workspace.worktree.hostId]
      : [
          folderWorkspaceKey(workspace.folderWorkspace.id),
          getFolderWorkspaceWorktreeHostId(workspace.folderWorkspace)
        ]
  const host = parseExecutionHostId(rawHostId)
  const entry = {
    opId: ++lastOpId,
    worktreeId,
    hostId: host?.id ?? null,
    workspace,
    answeredBy: null
  }
  startSettling()
  publish({ ...layer, created: [...layer.created, entry] })
  answer(
    new Set([entry.opId]),
    (pending) => pending.created,
    (pending, next) => ({ ...pending, created: next })
  )
}

/** Switch point. Keeps a workspace the window just removed out of the list until main drops it too. */
export function holdRemovedSidebarWorkspace(workspace: {
  worktreeId: string
  hostId: string | null | undefined
}): void {
  const hostId = parseExecutionHostId(workspace.hostId)?.id
  // Hostless, it would also hide a same-id copy main keeps listing on another host.
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || !hostId) {
    return
  }
  const entry = { opId: ++lastOpId, worktreeId: workspace.worktreeId, hostId, answeredBy: null }
  startSettling()
  publish({ ...layer, removed: [...layer.removed, entry] })
  answer(
    new Set([entry.opId]),
    (pending) => pending.removed,
    (pending, next) => ({ ...pending, removed: next })
  )
}

export function subscribeSidebarPendingLayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readSidebarPendingLayer(): SidebarPendingLayer {
  return layer
}
