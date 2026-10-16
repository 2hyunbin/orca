import { readSavedLineageCatalog } from './saved-worktree-lineage-catalog'
import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import { getWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageInstances,
  projectResolvedWorktreeLineage
} from '../shared/resolved-worktree-lineage'
import { areWorktreePathsEqual } from './ipc/worktree-path-comparison'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'
import type { RuntimeStore } from './runtime/runtime-store-contract'

type HostPeerStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getLineageEdges'
  | 'getLineageSnapshot'
>

/** Resolve connected lineage against persisted peers across execution hosts. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  _repo: Repo,
  rows: readonly T[]
) {
  if (rows.length === 0) {
    return projectResolvedWorktreeLineage(rows, {})
  }
  const catalog = readSavedLineageCatalog(store)
  const { endpoints, owners: savedOwners, lineage: lineageById } = catalog
  const relevant = (row: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>) =>
    endpoints.has(row.instanceId) ||
    endpoints.has(catalog.byLocator.get(getWorktreeHostIdentity(row))?.instanceId)
  if (!rows.some(relevant)) {
    return projectResolvedWorktreeLineage(rows, {})
  }
  const instances = new Set<string>()
  const locators = new Set<string>()
  const disagreement = rows.some((row) => {
    const key = getWorktreeHostIdentity(row)
    const duplicate = instances.has(row.instanceId ?? '') || locators.has(key)
    if (row.instanceId) {
      instances.add(row.instanceId)
    }
    locators.add(key)
    return (
      relevant(row) &&
      (duplicate ||
        catalog.byInstance.get(row.instanceId ?? '')?.id !== row.id ||
        getWorktreeHostIdentity(
          catalog.byInstance.get(row.instanceId ?? '') ?? { id: '', hostId: undefined }
        ) !== key ||
        catalog.byLocator.get(key)?.instanceId !== row.instanceId)
    )
  })
  if (!disagreement) {
    const ownKeys = new Set(rows.map(getWorktreeHostIdentity))
    const peers = new Map<string, Pick<Worktree, 'id' | 'hostId' | 'instanceId'>>()
    const incident: typeof lineageById = {}
    const add = (row: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>) => {
      const key = getWorktreeHostIdentity(row)
      if (!ownKeys.has(key)) {
        peers.set(key, row)
      }
      const edge = catalog.selected.get(key)
      if (edge) {
        incident[key] = edge.lineage
      }
    }
    for (const row of rows) {
      for (const child of catalog.children.get(getWorktreeHostIdentity(row)) ?? []) {
        add(child)
      }
    }
    for (const row of rows) {
      add(row)
      const edge = catalog.selected.get(getWorktreeHostIdentity(row))
      if (edge) {
        add(edge.parent)
      }
    }
    return projectResolvedWorktreeLineage(rows, incident, [...peers.values()])
  }
  const relatedInstances = getConnectedWorktreeLineageInstances(
    rows.flatMap((row) => (row.instanceId ? [row.instanceId] : [])),
    lineageById
  )
  const ownKeys = new Set(rows.map(getWorktreeHostIdentity))
  const peers: Worktree[] = []
  for (const meta of savedOwners) {
    const { id, repo: owner, hostId } = meta
    if (!relatedInstances.has(meta.instanceId)) {
      continue
    }
    if (ownKeys.has(getWorktreeHostIdentity({ id, hostId }))) {
      continue
    }
    if (resolveRepoOwnershipEvidence(owner).status !== 'owned') {
      continue
    }
    if (isFolderRepo(owner)) {
      if (isFolderWorkspaceIdForRepo(owner, id)) {
        const peerMeta =
          meta.instanceId || id === getFolderWorkspaceRootId(owner)
            ? meta
            : { ...meta, instanceId: getFolderWorkspaceInstanceIdentity(owner, id) }
        peers.push(mergeFolderWorkspace(owner, id, peerMeta))
      }
      continue
    }
    const parsed = splitWorktreeId(id)
    if (!parsed?.worktreePath) {
      continue
    }
    peers.push(
      mergeWorktree(
        owner.id,
        {
          path: parsed.worktreePath,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: areWorktreePathsEqual(parsed.worktreePath, owner.path)
        },
        meta,
        owner.displayName
      )
    )
  }
  return projectResolvedWorktreeLineage(rows, lineageById, peers)
}
