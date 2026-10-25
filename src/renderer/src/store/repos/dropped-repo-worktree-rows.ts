import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { worktreeMatchesHost } from '../slices/worktrees/listing/worktree-host-ownership'
import { selectDetectedWorktreesByRepo, selectWorktreesByRepo } from '../workspace-record-selectors'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../../shared/worktree/host-qualified-identity'

type HostedRow = { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
type RowState = Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>

/** Each repo id whose registration on these hosts a catalog write removed. */
function droppedHostsByRepo(
  previousRepos: readonly Repo[],
  nextRepos: readonly Repo[]
): Map<string, ExecutionHostId[]> {
  const nextIdentities = new Set(nextRepos.map(getRepoHostIdentity))
  const dropped = new Map<string, ExecutionHostId[]>()
  for (const repo of previousRepos) {
    if (!nextIdentities.has(getRepoHostIdentity(repo))) {
      dropped.set(repo.id, [...(dropped.get(repo.id) ?? []), getRepoExecutionHostId(repo)])
    }
  }
  return dropped
}

function dropHostRows<T extends HostedRow>(
  rowsByRepo: Record<string, T[]>,
  dropped: ReadonlyMap<string, readonly ExecutionHostId[]>,
  survivingRepoIds: ReadonlySet<string>,
  removed: HostWorktreeTarget[]
): Record<string, T[]> {
  let next: Record<string, T[]> | null = null
  for (const [repoId, hostIds] of dropped) {
    const rows = rowsByRepo[repoId]
    if (!rows) {
      continue
    }
    // Why: a pre-host row belongs to whichever owner had the id, so it goes only once none is left.
    const unhostedWorktreesMatchHost = !survivingRepoIds.has(repoId)
    const kept: T[] = []
    for (const row of rows) {
      const hostId = hostIds.find((candidate) =>
        worktreeMatchesHost(row, candidate, { unhostedWorktreesMatchHost })
      )
      if (!hostId) {
        kept.push(row)
        continue
      }
      removed.push(
        hostWorktreeTarget({
          id: row.id,
          hostId:
            row.hostId ??
            (row.runtimeOwnerEnvironmentId
              ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
              : hostId)
        })
      )
    }
    if (kept.length !== rows.length) {
      next ??= { ...rowsByRepo }
      next[repoId] = kept
    }
  }
  return next ?? rowsByRepo
}

/**
 * Drops the worktree rows of every repo registration a catalog write removed, and names them for
 * the purge. A host that relists its checkouts under new repo ids (a project copied into another
 * profile, then switched to) must not leave the old rows beside the new ones with no project.
 */
export function dropWorktreeRowsOfDroppedRepos(
  state: RowState,
  previousRepos: readonly Repo[],
  nextRepos: readonly Repo[]
): RowState & { removed: HostWorktreeTarget[] } {
  const dropped = droppedHostsByRepo(previousRepos, nextRepos)
  if (dropped.size === 0) {
    return { ...state, removed: [] }
  }
  const survivingRepoIds = new Set(nextRepos.map((repo) => repo.id))
  const removed: HostWorktreeTarget[] = []
  const previousWorktrees = selectWorktreesByRepo(state)
  const previousDetected = selectDetectedWorktreesByRepo(state)
  const worktreesByRepo = dropHostRows(previousWorktrees, dropped, survivingRepoIds, removed)
  // Why merged after: a detected row is usually the checkout its listed row already names.
  const detectedRemovals: HostWorktreeTarget[] = []
  let detectedWorktreesByRepo = previousDetected
  for (const repoId of dropped.keys()) {
    const detected = detectedWorktreesByRepo[repoId]
    if (!detected) {
      continue
    }
    const worktrees = dropHostRows(
      { [repoId]: detected.worktrees },
      dropped,
      survivingRepoIds,
      detectedRemovals
    )[repoId]
    if (worktrees !== detected.worktrees) {
      if (detectedWorktreesByRepo === previousDetected) {
        detectedWorktreesByRepo = { ...detectedWorktreesByRepo }
      }
      detectedWorktreesByRepo[repoId] = { ...detected, worktrees }
    }
  }
  const listed = new Set(removed.map((target) => `${target.hostId}\0${target.id}`))
  for (const target of detectedRemovals) {
    if (!listed.has(`${target.hostId}\0${target.id}`)) {
      removed.push(target)
    }
  }
  const changed =
    worktreesByRepo !== previousWorktrees || detectedWorktreesByRepo !== previousDetected
  return {
    worktreesByRepo,
    detectedWorktreesByRepo,
    sortEpoch: changed ? state.sortEpoch + 1 : state.sortEpoch,
    removed
  }
}
