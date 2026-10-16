import { edgeToWorktreeLineage, edgeToWorkspaceLineage } from '../shared/worktree/lineage-edge'
import { randomUUID } from 'node:crypto'
import type { Repo } from '../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { isWorkspaceKey, parseWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { splitWorktreeId } from '../shared/worktree/id'
import { worktreeRetentionPathComparisonKey } from './worktree-retention-path-comparison'
import type { Store } from './persistence'
import { isWslMoveRepoBlocked } from './persistence/moving-wsl-projects/wsl-move-background-backoff'
import { writeWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'

type WorktreeLineagePruningStore = Pick<Store, 'getRepos' | 'getWorktreeMeta' | 'setWorktreeMeta'> &
  Partial<
    Pick<
      Store,
      | 'getLineageEdges'
      | 'getAllWorktreeMeta'
      | 'getAllWorktreeMetaForHost'
      | 'setWorktreeMetaForHost'
      | 'getAllWorktreeLineage'
      | 'getAllWorkspaceLineage'
      | 'removeWorktreeLineage'
      | 'removeWorkspaceLineage'
    >
  >

function worktreeIdBelongsToRepo(worktreeId: string, repoPrefix: string): boolean {
  return worktreeId.startsWith(repoPrefix)
}

function workspaceKeyBelongsToRepo(workspaceKey: string, repoPrefix: string): boolean {
  const scope = parseWorkspaceKey(workspaceKey)
  return scope?.type === 'worktree' && worktreeIdBelongsToRepo(scope.worktreeId, repoPrefix)
}

function hasStoredRepoLineage(
  repoPrefix: string,
  worktreeLineage: Readonly<Record<string, WorktreeLineage>>,
  workspaceLineage: Readonly<Record<string, WorkspaceLineage>>
): boolean {
  return (
    Object.entries(worktreeLineage).some(
      ([childId, lineage]) =>
        worktreeIdBelongsToRepo(childId, repoPrefix) ||
        worktreeIdBelongsToRepo(lineage.parentWorktreeId, repoPrefix)
    ) ||
    Object.values(workspaceLineage).some(
      (lineage) =>
        workspaceKeyBelongsToRepo(lineage.childWorkspaceKey, repoPrefix) ||
        workspaceKeyBelongsToRepo(lineage.parentWorkspaceKey, repoPrefix)
    )
  )
}

export function pruneLineageForMissingRepoWorktrees(
  store: WorktreeLineagePruningStore,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  options: {
    platform?: NodeJS.Platform
    preservedMetadataCandidateIds?: ReadonlySet<string>
  } = {}
): void {
  const { platform = process.platform, preservedMetadataCandidateIds } = options
  // Mid-move a scan can miss paths that still exist; lineage waits for the move to settle.
  if (
    isWslMoveRepoBlocked(repo) ||
    typeof store.getAllWorktreeLineage !== 'function' ||
    typeof store.removeWorktreeLineage !== 'function'
  ) {
    return
  }
  const ownEdges = store
    .getLineageEdges?.()
    .filter((edge) => edge.child.hostId === getRepoExecutionHostId(repo))
  const worktreeLineage = ownEdges
    ? Object.fromEntries(
        ownEdges.flatMap((edge) => {
          const lineage = edgeToWorktreeLineage(edge)
          return lineage ? [[lineage.worktreeId, lineage]] : []
        })
      )
    : store.getAllWorktreeLineage()
  const workspaceLineage = ownEdges
    ? Object.fromEntries(ownEdges.map((edge) => [edge.child.locator, edgeToWorkspaceLineage(edge)]))
    : (store.getAllWorkspaceLineage?.() ?? {})
  const repoPrefix = `${repo.id}::`
  // Why: one empty observation cannot prove every registered lineage edge disappeared at once.
  if (
    gitWorktrees.length === 0 &&
    hasStoredRepoLineage(repoPrefix, worktreeLineage, workspaceLineage)
  ) {
    return
  }
  const liveIds = new Set(gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`))
  const livePathKeys = new Set(
    [repo.path, ...gitWorktrees.map(({ path }) => path)].map((pathValue) =>
      worktreeRetentionPathComparisonKey(pathValue, platform)
    )
  )
  const isLive = (worktreeId: string): boolean => {
    if (liveIds.has(worktreeId) || preservedMetadataCandidateIds?.has(worktreeId)) {
      return true
    }
    const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
    if (!worktreePath) {
      return false
    }
    if (livePathKeys.has(worktreeRetentionPathComparisonKey(worktreePath, platform))) {
      return true
    }
    return false
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  const ownedMeta = store.getAllWorktreeMetaForHost?.(expectedHostId)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  const canMutateWorktree = (worktreeId: string): boolean => {
    const hostId = (ownedMeta?.[worktreeId] ?? store.getWorktreeMeta(worktreeId))?.hostId
    return hostId ? hostId === expectedHostId : repoOwners.length === 1
  }
  for (const childWorkspaceKey of Object.keys(workspaceLineage)) {
    const childScope = parseWorkspaceKey(childWorkspaceKey)
    if (
      childScope?.type === 'worktree' &&
      worktreeIdBelongsToRepo(childScope.worktreeId, repoPrefix) &&
      (ownEdges !== undefined || canMutateWorktree(childScope.worktreeId)) &&
      !isLive(childScope.worktreeId) &&
      isWorkspaceKey(childWorkspaceKey)
    ) {
      store.removeWorkspaceLineage?.(
        childWorkspaceKey,
        workspaceLineage[childWorkspaceKey]?.childInstanceId ?? undefined
      )
    }
  }
  for (const [childId, lineage] of Object.entries(worktreeLineage)) {
    if (
      worktreeIdBelongsToRepo(childId, repoPrefix) &&
      (ownEdges !== undefined || canMutateWorktree(childId)) &&
      !isLive(childId)
    ) {
      // Why: a proven-missing path must not transfer its lineage to a future checkout at that path.
      store.removeWorktreeLineage(childId, lineage.worktreeInstanceId)
      store.removeWorkspaceLineage?.(worktreeWorkspaceKey(childId), lineage.worktreeInstanceId)
    }
    if (
      worktreeIdBelongsToRepo(lineage.parentWorktreeId, repoPrefix) &&
      canMutateWorktree(lineage.parentWorktreeId) &&
      !isLive(lineage.parentWorktreeId)
    ) {
      const parentMeta =
        ownedMeta?.[lineage.parentWorktreeId] ?? store.getWorktreeMeta(lineage.parentWorktreeId)
      if (parentMeta?.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: rotate a proven-missing parent's identity once so path reuse cannot validate old lineage.
        writeWorktreeMetaForHost(store, lineage.parentWorktreeId, expectedHostId, {
          instanceId: randomUUID()
        })
      }
    }
  }
}
