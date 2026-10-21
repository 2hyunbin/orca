import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  mergeWorkspaceLineageRecords,
  projectResolvedWorktreeLineage
} from '../shared/resolved-worktree-lineage'
import { readWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
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
  | 'getWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getAllWorkspaceLineage'
  | 'getFolderWorkspaces'
>

/** Project a per-repo publication against connected peers in this store. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  rows: readonly T[]
) {
  const lineageById = mergeWorkspaceLineageRecords(
    store.getAllWorktreeLineage?.() ?? {},
    store.getAllWorkspaceLineage?.() ?? {}
  )
  const ownIds = new Set(rows.map((row) => row.id))
  const folders =
    store
      .getFolderWorkspaces?.()
      .map(folderWorkspaceToWorktree)
      .filter((row) => !ownIds.has(row.id)) ?? []
  if (rows.length === 0) {
    return projectResolvedWorktreeLineage(rows, lineageById, folders)
  }
  const relatedIds = getConnectedWorktreeLineageIds(
    rows.map((row) => row.id),
    lineageById
  )
  if ([...relatedIds].every((id) => ownIds.has(id))) {
    return projectResolvedWorktreeLineage(rows, lineageById, folders)
  }
  const repos = store.getRepos()
  const reposById = new Map<string, Repo[]>()
  for (const candidate of repos) {
    const owners = reposById.get(candidate.id) ?? []
    owners.push(candidate)
    reposById.set(candidate.id, owners)
  }
  const legacyMeta = store.getAllWorktreeMeta()
  const peers: Worktree[] = []
  for (const id of relatedIds) {
    if (ownIds.has(id)) {
      continue
    }
    const owners = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    const evidence = owners.map(resolveRepoOwnershipEvidence)
    if (evidence.some((owner) => owner.status !== 'owned')) {
      continue
    }
    for (const owner of owners) {
      const ownerHostId = getRepoExecutionHostId(owner)
      const legacy = legacyMeta[id]
      const meta =
        readWorktreeMetaForHost(store, id, ownerHostId) ??
        (legacy?.hostId === ownerHostId || (!legacy?.hostId && owners.length === 1)
          ? legacy
          : undefined)
      if (!meta || (!meta.instanceId && !isFolderRepo(owner))) {
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
  }
  return projectResolvedWorktreeLineage(rows, lineageById, [...folders, ...peers])
}
