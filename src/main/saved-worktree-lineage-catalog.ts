import type { ExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { WorktreeLineage } from '../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import {
  selectResolvedWorktreeLineage,
  indexWorktreesByInstance
} from '../shared/resolved-worktree-lineage'
import { edgeToWorktreeLineage, worktreeLineageToEdge } from '../shared/worktree/lineage-edge'
import { isFolderRepo } from '../shared/repo-kind'
import { isFolderWorkspaceIdForRepo } from './ipc/worktrees/folder-workspace-model'
import { getWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
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
  | 'getLineageSnapshot'
>

export function readSavedWorktreeOwners(store: CatalogStore) {
  const repos = store.getRepos()
  const invalidRepoIds = new Set(
    repos
      .filter((repo) => resolveRepoOwnershipEvidence(repo).status !== 'owned')
      .map((repo) => repo.id)
  )
  const counts = new Map<string, number>()
  const ownersByHost = new Map<ExecutionHostId, Map<string, Repo | null>>()
  for (const repo of repos) {
    counts.set(repo.id, (counts.get(repo.id) ?? 0) + 1)
    const hostId = getRepoExecutionHostId(repo)
    const owners = ownersByHost.get(hostId) ?? new Map<string, Repo | null>()
    owners.set(repo.id, owners.has(repo.id) || invalidRepoIds.has(repo.id) ? null : repo)
    ownersByHost.set(hostId, owners)
  }
  const rows: (WorktreeMeta & {
    id: string
    instanceId: string
    hostId: ExecutionHostId
    repo: Repo
  })[] = []
  for (const [hostId, owners] of ownersByHost) {
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
  store: Pick<CatalogStore, 'getLineageEdges' | 'getAllWorktreeLineage'>,
  mode?: 'stored'
) {
  return (
    store.getLineageEdges?.(mode) ??
    Object.values(store.getAllWorktreeLineage?.() ?? {}).flatMap((lineage) => {
      const edge = worktreeLineageToEdge(lineage)
      return edge ? [edge] : []
    })
  )
}

type SavedOwner = ReturnType<typeof readSavedWorktreeOwners>[number]

export function readSavedWorktreeLineage(
  store: CatalogStore,
  rows?: readonly SavedOwner[],
  edges?: ReturnType<typeof readSavedLineageEdges>,
  owners?: ReadonlyMap<string, SavedOwner | null>
): Record<string, WorktreeLineage> {
  if (!store.getLineageEdges) {
    return store.getAllWorktreeLineage?.() ?? {}
  }
  if (!rows && !edges && store.getLineageSnapshot) {
    return readSavedLineageCatalog(store).ownedLineage
  }
  rows ??= readSavedWorktreeOwners(store)
  edges ??= readSavedLineageEdges(store)
  owners ??= indexWorktreesByInstance(rows)
  return Object.fromEntries(
    edges.flatMap((edge) => {
      const owner = owners.get(edge.child.instanceId)
      const parent = edge.parent.instanceId && owners.get(edge.parent.instanceId)
      const lineage = edgeToWorktreeLineage(edge)
      return owner && parent && lineage
        ? [
            [
              getWorktreeHostIdentity(owner),
              { ...lineage, worktreeId: owner.id, parentWorktreeId: parent.id }
            ]
          ]
        : []
    })
  )
}

const catalogs = new WeakMap<object, ReturnType<typeof buildSavedLineageCatalog>>()
export function readSavedLineageCatalog(store: CatalogStore) {
  const snapshot = store.getLineageSnapshot?.()
  const cached = snapshot && catalogs.get(snapshot)
  if (cached) {
    return cached
  }
  const catalog = buildSavedLineageCatalog(
    store,
    snapshot?.stored ?? readSavedLineageEdges(store, 'stored')
  )
  if (snapshot) {
    catalogs.set(snapshot, catalog)
  }
  return catalog
}
function buildSavedLineageCatalog(
  store: CatalogStore,
  edges: ReturnType<typeof readSavedLineageEdges>
) {
  const endpoints = new Set(
    edges.flatMap((edge) =>
      edge.parent.instanceId
        ? [edge.child.instanceId, edge.parent.instanceId]
        : [edge.child.instanceId]
    )
  )
  const owners = Object.freeze(
    edges.length ? readSavedWorktreeOwners(store).map((row) => Object.freeze(row)) : []
  )
  const byInstance = indexWorktreesByInstance(owners)
  const lineage = readSavedWorktreeLineage(store, owners, edges, byInstance)
  const ownedEdges = readSavedLineageEdges(store)
  const ownedLineage = readSavedWorktreeLineage(store, owners, ownedEdges, byInstance)
  const eligible = owners.filter((row) =>
    isFolderRepo(row.repo)
      ? isFolderWorkspaceIdForRepo(row.repo, row.id)
      : Boolean(splitWorktreeId(row.id)?.worktreePath)
  )
  const byLocator = new Map(eligible.map((row) => [getWorktreeHostIdentity(row), row]))
  const buildGraph = () => {
    const { selected } = selectResolvedWorktreeLineage(
      eligible,
      (row) => lineage[getWorktreeHostIdentity(row)]
    )
    const children = new Map<string, SavedOwner[]>()
    for (const row of eligible) {
      const edge = selected.get(getWorktreeHostIdentity(row))
      if (!edge) {
        continue
      }
      const key = getWorktreeHostIdentity(edge.parent)
      const siblings = children.get(key) ?? []
      siblings.push(row)
      children.set(key, siblings)
    }
    selected.forEach(Object.freeze)
    children.forEach(Object.freeze)
    return { selected, children }
  }
  let graph: ReturnType<typeof buildGraph> | undefined
  const edgesByChild = new Map(ownedEdges.map((edge) => [edge.child.instanceId, edge]))
  Object.values(lineage).forEach(Object.freeze)
  Object.values(ownedLineage).forEach(Object.freeze)
  Object.freeze(lineage)
  Object.freeze(ownedLineage)
  return Object.freeze({
    edges,
    endpoints: { has: (instance?: string) => Boolean(instance && endpoints.has(instance)) },
    owners,
    byInstance: { get: byInstance.get.bind(byInstance) },
    byLocator: { get: byLocator.get.bind(byLocator) },
    lineage,
    selected: { get: (key: string) => (graph ??= buildGraph()).selected.get(key) },
    children: { get: (key: string) => (graph ??= buildGraph()).children.get(key) },
    edgesByChild: { get: edgesByChild.get.bind(edgesByChild) },
    ownedLineage
  })
}
