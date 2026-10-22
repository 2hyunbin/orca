import type { Worktree } from '../shared/worktree/types'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { WorktreeLineage } from '../shared/worktree/lineage-types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  getCyclicLineageChildKeys,
  isValidResolvedWorktreeLineageEdge,
  type WorktreeWithResolvedLineage,
  getSavedWorktreeLineage,
  worktreeLineageFromWorkspaceLineage
} from '../shared/resolved-worktree-lineage'
import { readAllWorktreeMetaForHost } from './persistence/host-qualified-worktree-meta'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import type { RuntimeStore } from './runtime/runtime-store-contract'

type HostPeerStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getAllWorktreeLineage'
  | 'getWorkspaceLineage'
  | 'getWorktreeMeta'
>

/** Saved intent is independent of the base publication's resolved fields. */
export function withSavedWorktreeLineage<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  rows: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>> = store.getAllWorktreeLineage?.() ?? {},
  raw?: Readonly<Record<string, WorktreeMeta>>
) {
  return rows.map((row) => {
    const key = row.id.startsWith('folder:')
      ? folderWorkspaceKey(row.id.slice(7))
      : worktreeWorkspaceKey(row.id)
    const workspaceEdge = lineageById[row.id] ? undefined : store.getWorkspaceLineage?.(key)
    const ownEdge =
      lineageById[row.id] ??
      (workspaceEdge ? worktreeLineageFromWorkspaceLineage(workspaceEdge) : undefined)
    const owner = raw === undefined && ownEdge ? store.getWorktreeMeta?.(row.id) : undefined
    const metadata = raw ?? (owner ? { [row.id]: owner } : undefined)
    const savedLineage =
      getSavedWorktreeLineage(
        {
          ...row,
          hostId: row.hostId ?? getRepoExecutionHostId(repo),
          savedLineage: undefined,
          lineage: ownEdge ?? null
        },
        lineageById,
        metadata
      ) ?? null
    return { ...row, savedLineage }
  })
}

/** Project a per-repo publication against persisted peers on its execution host. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: HostPeerStore,
  repo: Repo,
  input: readonly T[],
  rawMetadata?: Readonly<Record<string, WorktreeMeta>>
) {
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const rows = withSavedWorktreeLineage(store, repo, input, lineageById, rawMetadata)
  const project = (peers: readonly Worktree[] = []) =>
    projectPublishedWorktreeLineage(rows, lineageById, peers)
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
  const metaById = readAllWorktreeMetaForHost(store, hostId)
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
    const meta = metaById[id]
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

function projectPublishedWorktreeLineage<T extends Worktree>(
  worktrees: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  knownPeers: readonly Worktree[] = []
): WorktreeWithResolvedLineage<T>[] {
  const allWorktrees: readonly Worktree[] = [...worktrees, ...knownPeers]
  const indicesById = new Map<string, number[]>()
  allWorktrees.forEach((worktree, index) => {
    const indices = indicesById.get(worktree.id) ?? []
    indices.push(index)
    indicesById.set(worktree.id, indices)
  })
  const validLineageByChildIndex = new Map<number, WorktreeLineage>()
  const parentIndexByChildIndex = new Map<number, number>()
  const childIdsByParentIndex = new Map<number, string[]>()

  allWorktrees.forEach((child, childIndex) => {
    const lineage = lineageById[child.id]
    if (!lineage) {
      return
    }
    const parentIndices = (indicesById.get(lineage.parentWorktreeId) ?? []).filter((index) =>
      isValidResolvedWorktreeLineageEdge(child, allWorktrees[index], lineage)
    )
    // A locator can exist on several hosts. An ambiguous parent must not be selected by row order.
    if (parentIndices.length !== 1) {
      return
    }
    validLineageByChildIndex.set(childIndex, lineage)
    parentIndexByChildIndex.set(childIndex, parentIndices[0])
  })

  for (const index of getCyclicLineageChildKeys(parentIndexByChildIndex)) {
    validLineageByChildIndex.delete(index)
    parentIndexByChildIndex.delete(index)
  }

  for (const [childIndex, parentIndex] of parentIndexByChildIndex) {
    const children = childIdsByParentIndex.get(parentIndex) ?? []
    children.push(allWorktrees[childIndex].id)
    childIdsByParentIndex.set(parentIndex, children)
  }

  return worktrees.map((worktree, index) => {
    const lineage = validLineageByChildIndex.get(index) ?? null
    return {
      ...worktree,
      savedLineage: worktree.savedLineage ?? null,
      parentWorktreeId: lineage?.parentWorktreeId ?? null,
      childWorktreeIds: childIdsByParentIndex.get(index) ?? [],
      lineage
    }
  })
}
