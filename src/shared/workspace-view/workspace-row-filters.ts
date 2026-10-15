import type { ExecutionHostId } from '../execution-host'

/** The Workspace options filters, under their persisted names. One value, shared by every surface. */
export type WorkspaceRowFilters = {
  hideSleepingWorkspaces: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep. Absent means on (#8873). */
  alwaysShowDefaultBranchWorkspace?: boolean
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  filterRepoIds: readonly string[]
  /** The hosts shown; null shows every host. */
  visibleHostIds: readonly ExecutionHostId[] | null
}

/**
 * How one surface reads the facts the filters decide on from its own rows. The desktop derives
 * them from its worktrees and tabs; the phone reads what the host stamped on the rows it served,
 * so a fact an older host never sent reads false and the row stays visible.
 */
export type WorkspaceRowFactReader<Row> = {
  isArchived: (row: Row) => boolean
  /** A folder workspace follows only the host and other-client filters, as the sidebar's lanes do. */
  isFolderWorkspace: (row: Row) => boolean
  repoId: (row: Row) => string
  /** Null when the row's host cannot be resolved; a host filter then hides it. */
  hostId: (row: Row) => ExecutionHostId | null
  isOtherClient: (row: Row) => boolean
  isDefaultBranch: (row: Row) => boolean
  isAutomationCreated: (row: Row) => boolean
  isCliCreated: (row: Row) => boolean
  isDetachedHead: (row: Row) => boolean
  isMainWorktree: (row: Row) => boolean
  isSleeping: (row: Row) => boolean
}

/**
 * Whether "Hide sleeping" must keep this row (#8873).
 *
 * Why the main worktree and not the default-branch test: the project's primary checkout is its only
 * guaranteed entry point. Detached-HEAD and offline SSH mains fail the default-branch test yet often
 * have no sibling row, so sweeping them drops the whole project with no way back.
 */
export function isSleepingSweepExempt(
  isMainWorktree: boolean,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return alwaysShowDefaultBranchWorkspace !== false && isMainWorktree
}

/**
 * Whether turning the exemption off is narrowing the list. It only bites during the "Hide
 * sleeping" sweep, so its row and the filter badge ignore it while sleeping workspaces are shown.
 */
export function isSleepingSweepExemptionNarrowingList(
  hideSleepingWorkspaces: boolean,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return hideSleepingWorkspaces && alwaysShowDefaultBranchWorkspace === false
}

export function isWorkspaceRowVisible<Row>(
  row: Row,
  filters: WorkspaceRowFilters,
  read: WorkspaceRowFactReader<Row>,
  scope: { repoIds: ReadonlySet<string> | null; hostIds: ReadonlySet<ExecutionHostId> | null }
): boolean {
  if (read.isArchived(row)) {
    return false
  }
  if (filters.hideWorkspacesFromOtherDevices && read.isOtherClient(row)) {
    return false
  }
  if (scope.hostIds) {
    const hostId = read.hostId(row)
    if (hostId === null || !scope.hostIds.has(hostId)) {
      return false
    }
  }
  if (read.isFolderWorkspace(row)) {
    return true
  }
  if (filters.hideDefaultBranchWorkspace && read.isDefaultBranch(row)) {
    return false
  }
  if (filters.hideAutomationGeneratedWorkspaces && read.isAutomationCreated(row)) {
    return false
  }
  if (filters.hideCliCreatedWorkspaces && read.isCliCreated(row)) {
    return false
  }
  if (filters.hideDetachedHeadWorkspaces && read.isDetachedHead(row)) {
    return false
  }
  if (scope.repoIds && !scope.repoIds.has(read.repoId(row))) {
    return false
  }
  // Why the explicit hide above still wins: the exemption only shields a row from the sweep.
  return (
    !filters.hideSleepingWorkspaces ||
    isSleepingSweepExempt(read.isMainWorktree(row), filters.alwaysShowDefaultBranchWorkspace) ||
    !read.isSleeping(row)
  )
}

/** The rows the Workspace options filters keep, in their given order. */
export function filterWorkspaceRows<Row>(
  rows: readonly Row[],
  filters: WorkspaceRowFilters,
  read: WorkspaceRowFactReader<Row>
): Row[] {
  const scope = {
    repoIds: filters.filterRepoIds.length > 0 ? new Set(filters.filterRepoIds) : null,
    hostIds: filters.visibleHostIds ? new Set(filters.visibleHostIds) : null
  }
  return rows.filter((row) => isWorkspaceRowVisible(row, filters, read, scope))
}

/**
 * The options button's badge: one per narrowing filter, plus one per selected project.
 * Why only known repos: a stale id left behind by a removed repo must not read as a filter.
 */
export function countActiveWorkspaceFilters(
  filters: WorkspaceRowFilters,
  knownRepoIds: readonly string[]
): number {
  const flags = [
    filters.hideSleepingWorkspaces,
    filters.hideDefaultBranchWorkspace,
    filters.hideAutomationGeneratedWorkspaces,
    filters.hideCliCreatedWorkspaces,
    filters.hideDetachedHeadWorkspaces,
    filters.hideWorkspacesFromOtherDevices,
    isSleepingSweepExemptionNarrowingList(
      filters.hideSleepingWorkspaces,
      filters.alwaysShowDefaultBranchWorkspace
    ),
    filters.visibleHostIds !== null
  ]
  const selectedRepoCount = knownRepoIds.filter((id) => filters.filterRepoIds.includes(id)).length
  return flags.filter(Boolean).length + selectedRepoCount
}
