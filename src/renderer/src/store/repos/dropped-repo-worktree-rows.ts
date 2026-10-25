import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { worktreeMatchesHost } from '../slices/worktrees/listing/worktree-host-ownership'

type HostedRow = { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
type RowState = Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>

function dropHostRows<T extends HostedRow>(
  rowsByRepo: Record<string, T[]>,
  droppedHostsByRepo: ReadonlyMap<string, readonly ExecutionHostId[]>,
  survivingRepoIds: ReadonlySet<string>
): Record<string, T[]> {
  let next: Record<string, T[]> | null = null
  for (const [repoId, hostIds] of droppedHostsByRepo) {
    const rows = rowsByRepo[repoId]
    if (!rows) {
      continue
    }
    // Why: a pre-host row belongs to whichever owner had the id, so it goes only once none is left.
    const unhostedWorktreesMatchHost = !survivingRepoIds.has(repoId)
    const kept = rows.filter(
      (row) =>
        !hostIds.some((hostId) => worktreeMatchesHost(row, hostId, { unhostedWorktreesMatchHost }))
    )
    if (kept.length !== rows.length) {
      next ??= { ...rowsByRepo }
      next[repoId] = kept
    }
  }
  return next ?? rowsByRepo
}

/**
 * Drops the worktree rows of every repo registration a catalog write removed. A host that relists
 * its checkouts under new repo ids (a project copied into another profile, then switched to) must
 * not leave the old rows listed beside the new ones with no project to group under.
 */
export function dropWorktreeRowsOfDroppedRepos(
  state: RowState,
  previousRepos: readonly Repo[],
  nextRepos: readonly Repo[]
): RowState {
  const nextIdentities = new Set(nextRepos.map(getRepoHostIdentity))
  const droppedHostsByRepo = new Map<string, ExecutionHostId[]>()
  for (const repo of previousRepos) {
    if (!nextIdentities.has(getRepoHostIdentity(repo))) {
      const hostIds = droppedHostsByRepo.get(repo.id) ?? []
      hostIds.push(getRepoExecutionHostId(repo))
      droppedHostsByRepo.set(repo.id, hostIds)
    }
  }
  if (droppedHostsByRepo.size === 0) {
    return state
  }
  const survivingRepoIds = new Set(nextRepos.map((repo) => repo.id))
  const worktreesByRepo = dropHostRows(state.worktreesByRepo, droppedHostsByRepo, survivingRepoIds)
  let detectedWorktreesByRepo = state.detectedWorktreesByRepo
  for (const repoId of droppedHostsByRepo.keys()) {
    const detected = detectedWorktreesByRepo[repoId]
    if (!detected) {
      continue
    }
    const worktrees = dropHostRows(
      { [repoId]: detected.worktrees },
      droppedHostsByRepo,
      survivingRepoIds
    )[repoId]
    if (worktrees !== detected.worktrees) {
      if (detectedWorktreesByRepo === state.detectedWorktreesByRepo) {
        detectedWorktreesByRepo = { ...detectedWorktreesByRepo }
      }
      detectedWorktreesByRepo[repoId] = { ...detected, worktrees }
    }
  }
  const changed =
    worktreesByRepo !== state.worktreesByRepo ||
    detectedWorktreesByRepo !== state.detectedWorktreesByRepo
  return {
    worktreesByRepo,
    detectedWorktreesByRepo,
    sortEpoch: changed ? state.sortEpoch + 1 : state.sortEpoch
  }
}
