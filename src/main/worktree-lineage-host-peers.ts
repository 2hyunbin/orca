import { readSavedWorktreeLineage, readSavedWorktreeOwners } from './saved-worktree-lineage-catalog'
import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import { getWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
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
>

/** Resolve connected lineage against persisted peers across execution hosts. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[]
) {
  const savedOwners = readSavedWorktreeOwners(store)
  const lineageById = readSavedWorktreeLineage(store, savedOwners)
  if (rows.length === 0) {
    return projectResolvedWorktreeLineage(rows, lineageById)
  }
  const relatedIds = getConnectedWorktreeLineageIds(
    rows.map((row) => row.id),
    lineageById
  )
  const ownKeys = new Set(rows.map(getWorktreeHostIdentity))
  const relatedInstances = new Set(
    Object.values(lineageById).flatMap((edge) =>
      relatedIds.has(edge.worktreeId) || relatedIds.has(edge.parentWorktreeId)
        ? [edge.worktreeInstanceId, edge.parentWorktreeInstanceId]
        : []
    )
  )
  const peers: Worktree[] = []
  for (const meta of savedOwners) {
    const { id, repo: owner, hostId } = meta
    if (!relatedIds.has(id) && !relatedInstances.has(meta.instanceId)) {
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
