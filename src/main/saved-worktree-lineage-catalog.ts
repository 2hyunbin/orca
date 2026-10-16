import type { ExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import { indexWorktreesByInstance } from '../shared/resolved-worktree-lineage'
import { edgeToWorktreeLineage, worktreeLineageToEdge } from '../shared/worktree/lineage-edge'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import type { RuntimeStore } from './runtime/runtime-store-contract'
import { readAllWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from './worktree-metadata-ownership'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'

type CatalogStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getLineageEdges'
>

export function readSavedWorktreeOwners(store: CatalogStore) {
  const repos = store.getRepos()
  const invalidRepoIds = new Set(
    repos
      .filter((repo) => resolveRepoOwnershipEvidence(repo).status !== 'owned')
      .map((repo) => repo.id)
  )
  const counts = new Map<string, number>()
  for (const repo of repos) {
    counts.set(repo.id, (counts.get(repo.id) ?? 0) + 1)
  }
  const rows: (WorktreeMeta & {
    id: string
    instanceId: string
    hostId: ExecutionHostId
    repo: Repo
  })[] = []
  for (const hostId of new Set(repos.map(getRepoExecutionHostId))) {
    const hostRepos = repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    const owners = new Map(
      hostRepos
        .filter(
          (repo) =>
            !invalidRepoIds.has(repo.id) &&
            hostRepos.filter((candidate) => candidate.id === repo.id).length === 1
        )
        .map((repo) => [repo.id, repo])
    )
    const snapshot = readAllWorktreeMetaForHost(store, hostId)
    for (const [id] of Object.entries(snapshot)) {
      const repo = owners.get(getRepoIdFromWorktreeId(id))
      const meta = repo && getRepoOwnedWorktreeMeta(repo, id, snapshot, counts.get(repo.id) ?? 0)
      if (repo && meta?.instanceId) {
        rows.push({ ...meta, instanceId: meta.instanceId, id, hostId, repo })
      }
    }
  }
  return rows
}

export function readSavedLineageEdges(
  store: Pick<CatalogStore, 'getLineageEdges' | 'getAllWorktreeLineage'>
) {
  return (
    store.getLineageEdges?.() ??
    Object.values(store.getAllWorktreeLineage?.() ?? {}).flatMap((lineage) => {
      const edge = worktreeLineageToEdge(lineage)
      return edge ? [edge] : []
    })
  )
}

export function readSavedWorktreeLineage(
  store: CatalogStore,
  rows = readSavedWorktreeOwners(store)
) {
  if (!store.getLineageEdges) {
    return store.getAllWorktreeLineage?.() ?? {}
  }
  const owners = indexWorktreesByInstance(rows)
  return Object.fromEntries(
    readSavedLineageEdges(store).flatMap((edge) => {
      const owner = owners.get(edge.child.instanceId)
      const lineage = edgeToWorktreeLineage(edge)
      return owner && lineage
        ? [
            [
              composeWorktreeHostIdentity(owner.hostId, owner.id),
              { ...lineage, worktreeId: owner.id }
            ]
          ]
        : []
    })
  )
}
