import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getWorktreeHostIdentity,
  type HostScopedWorktreeKey,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import { getIndexedAllWorktrees, getIndexedWorktreesById } from './worktree-repo-index'
import {
  folderWorkspaceMatchesHost,
  getFolderWorkspaceWorktree
} from './slices/worktrees/listing/detected-worktree-meta'

// The one read path for workspace records. Backed by today's store fields; readers outside the
// writers go through here (config/scripts/check-workspace-record-read-ratchet.mjs).

export type WorkspaceRecordState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>

export type WorkspaceRecordFilter = {
  /** `worktree` = git worktrees, `folder` = folder workspaces' rows; both when omitted. */
  readonly kind?: 'worktree' | 'folder'
  readonly repoId?: string
  readonly hostId?: ExecutionHostId
}

// ─── Compatibility views ─────────────────────────────────────────────

/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo(
  state: Pick<AppState, 'worktreesByRepo'>
): AppState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces(
  state: Pick<AppState, 'folderWorkspaces'>
): AppState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo(
  state: Pick<AppState, 'detectedWorktreesByRepo'>
): AppState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}

/** Every host's git worktree row for one bare id; the caller picks among same-id twins. */
export function selectWorktreeRowsByBareId(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string
): readonly Worktree[] {
  return getIndexedWorktreesById(state.worktreesByRepo, worktreeId)
}

// ─── Keyed records ───────────────────────────────────────────────────

type WorkspaceRecordIndex = {
  all: readonly Worktree[]
  folders: readonly Worktree[]
  byKey: ReadonlyMap<HostScopedWorktreeKey, Worktree>
  filtered: Map<string, readonly Worktree[]>
}

const EMPTY_WORKSPACES: readonly Worktree[] = []

// Why two levels: either field can change alone, and neither may pin a replaced snapshot.
const workspaceRecordIndexCache = new WeakMap<
  AppState['worktreesByRepo'],
  WeakMap<AppState['folderWorkspaces'], WorkspaceRecordIndex>
>()

function getWorkspaceRecordIndex(state: WorkspaceRecordState): WorkspaceRecordIndex {
  let byFolders = workspaceRecordIndexCache.get(state.worktreesByRepo)
  if (!byFolders) {
    byFolders = new WeakMap()
    workspaceRecordIndexCache.set(state.worktreesByRepo, byFolders)
  }
  const cached = byFolders.get(state.folderWorkspaces)
  if (cached) {
    return cached
  }
  const worktrees = getIndexedAllWorktrees(state.worktreesByRepo)
  const folders = state.folderWorkspaces.map(getFolderWorkspaceWorktree)
  const all = folders.length === 0 ? worktrees : [...worktrees, ...folders]
  const byKey = new Map<HostScopedWorktreeKey, Worktree>()
  for (const row of all) {
    // First wins, so a repeated folder row cannot displace the git worktree listed before it.
    const key = getWorktreeHostIdentity(row)
    if (!byKey.has(key)) {
      byKey.set(key, row)
    }
  }
  const index = { all, folders, byKey, filtered: new Map() }
  byFolders.set(state.folderWorkspaces, index)
  return index
}

/** The workspace (git worktree or folder workspace row) one host publishes under `key`. */
export function selectWorkspace(
  state: WorkspaceRecordState,
  key: HostScopedWorktreeKey
): Worktree | undefined {
  return getWorkspaceRecordIndex(state).byKey.get(key)
}

/** Stable per store snapshot and filter, so it is safe as a Zustand selector result. */
export function selectWorkspaces(
  state: WorkspaceRecordState,
  filter: WorkspaceRecordFilter = {}
): readonly Worktree[] {
  const index = getWorkspaceRecordIndex(state)
  const { kind, repoId, hostId } = filter
  if (!kind && repoId === undefined && hostId === undefined) {
    return index.all
  }
  if (kind === 'worktree' && repoId === undefined && hostId === undefined) {
    return getIndexedAllWorktrees(state.worktreesByRepo)
  }
  const filterKey = `${kind ?? ''}\u0000${repoId ?? ''}\u0000${hostId ?? ''}`
  const cached = index.filtered.get(filterKey)
  if (cached) {
    return cached
  }
  const rows =
    kind === 'folder'
      ? index.folders
      : kind === 'worktree'
        ? getIndexedAllWorktrees(state.worktreesByRepo)
        : index.all
  const matches = rows.filter(
    (row) =>
      (repoId === undefined || row.repoId === repoId) &&
      (hostId === undefined || row.hostId === hostId)
  )
  const result = matches.length === 0 ? EMPTY_WORKSPACES : matches
  index.filtered.set(filterKey, result)
  return result
}

// Every listed row, same-host duplicates included, so an owner object is always found again.
const listedRowsByBareIdCache = new WeakMap<
  AppState['worktreesByRepo'],
  ReadonlyMap<string, readonly Worktree[]>
>()

function getListedRowsByBareId(
  worktreesByRepo: AppState['worktreesByRepo']
): ReadonlyMap<string, readonly Worktree[]> {
  const cached = listedRowsByBareIdCache.get(worktreesByRepo)
  if (cached) {
    return cached
  }
  const byId = new Map<string, Worktree[]>()
  for (const rows of Object.values(worktreesByRepo)) {
    for (const row of rows) {
      const listed = byId.get(row.id)
      if (listed) {
        listed.push(row)
      } else {
        byId.set(row.id, [row])
      }
    }
  }
  listedRowsByBareIdCache.set(worktreesByRepo, byId)
  return byId
}

function findFolderWorkspaceForTarget(
  folderWorkspaces: readonly FolderWorkspace[],
  folderWorkspaceId: string,
  hostId: ExecutionHostId
): FolderWorkspace | undefined {
  return folderWorkspaces.find(
    (workspace) =>
      workspace.id === folderWorkspaceId && folderWorkspaceMatchesHost(workspace, hostId)
  )
}

/**
 * The row that owns `target` on its host, including a paired runtime's logical host alias.
 * Unlike `selectWorkspace`, an ambiguous owner on that host answers undefined.
 */
export function selectWorkspaceByHostTarget(
  state: WorkspaceRecordState,
  target: HostWorktreeTarget
): Worktree | undefined {
  const scope = parseWorkspaceKey(target.id)
  if (scope?.type === 'folder') {
    const folder = findFolderWorkspaceForTarget(
      state.folderWorkspaces,
      scope.folderWorkspaceId,
      target.hostId
    )
    return folder ? getFolderWorkspaceWorktree(folder) : undefined
  }
  const owner = findIndexedWorktreeOwnerForHost(state.worktreesByRepo, target.id, target.hostId)
  // The owner index holds the listed row objects; recover the full row by identity.
  return owner
    ? getListedRowsByBareId(state.worktreesByRepo)
        .get(target.id)
        ?.find((row) => row === owner)
    : undefined
}
