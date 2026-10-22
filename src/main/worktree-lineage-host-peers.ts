import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage,
  getSavedWorktreeLineage,
  worktreeLineageFromWorkspaceLineage
} from '../shared/resolved-worktree-lineage'
import { peekWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'
import { worktreeWorkspaceKey } from '../shared/workspace-scope'
import type { RuntimeStore } from './runtime/runtime-store-contract'

type HostPeerStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getAllWorktreeMeta'
  | 'peekWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getAllWorkspaceLineage'
>

/** Saved intent is independent of the base publication's resolved fields. */
export function withSavedWorktreeLineage<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[]
) {
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const raw = store.getAllWorktreeMeta?.() ?? {}
  const workspaceEdges = store.getAllWorkspaceLineage?.() ?? {}
  return rows.map((row) => {
    const key = row.id.startsWith('folder:') ? row.id : worktreeWorkspaceKey(row.id)
    const workspaceEdge = workspaceEdges[key]
    const ownEdge =
      lineageById[row.id] ??
      (workspaceEdge ? worktreeLineageFromWorkspaceLineage(workspaceEdge) : undefined)
    const savedLineage =
      getSavedWorktreeLineage(
        {
          ...row,
          hostId: row.hostId ?? getRepoExecutionHostId(repo),
          savedLineage: undefined,
          lineage: ownEdge ?? null
        },
        lineageById,
        raw
      ) ?? null
    return { ...row, savedLineage }
  })
}

/** Project a per-repo publication against persisted peers on its execution host. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  input: readonly T[]
) {
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const raw = store.getAllWorktreeMeta?.() ?? {}
  const rows = withSavedWorktreeLineage(store, repo, input)
  const project = (peers: readonly Worktree[] = []) =>
    projectResolvedWorktreeLineage(rows, lineageById, peers, raw, 'publication')
  if (rows.length === 0) {
    return project()
  }
  const relatedIds = getConnectedWorktreeLineageIds(
    rows.map((row) => row.id),
    lineageById
  )
  const ownIds = new Set(rows.map((row) => row.id))
  if ([...relatedIds].every((id) => ownIds.has(id) || getRepoIdFromWorktreeId(id) === repo.id)) {
    return project()
  }
  const hostId = getRepoExecutionHostId(repo)
  const repos = store.getRepos()
  const reposById = new Map<string, Repo[]>()
  for (const candidate of repos) {
    const owners = reposById.get(candidate.id) ?? []
    owners.push(candidate)
    reposById.set(candidate.id, owners)
  }
  const peers: Worktree[] = []
  for (const id of relatedIds) {
    if (ownIds.has(id) || getRepoIdFromWorktreeId(id) === repo.id) {
      continue
    }
    const owners = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    const evidence = owners.map(resolveRepoOwnershipEvidence)
    const hostOwners = owners.filter((_, index) => {
      const owner = evidence[index]
      return owner?.status === 'owned' && owner.hostId === hostId
    })
    const meta = peekWorktreeMetaForHost(store, id, hostId)
    if (
      evidence.some((owner) => owner.status !== 'owned') ||
      hostOwners.length !== 1 ||
      !meta ||
      (!meta.instanceId && !isFolderRepo(hostOwners[0])) ||
      (!meta.hostId && owners.length > 1)
    ) {
      continue
    }
    const owner = hostOwners[0]
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
  return project(peers)
}
