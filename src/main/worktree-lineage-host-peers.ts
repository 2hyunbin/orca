import { getWorktreeLineageCandidates, type CandidateStore } from './worktree-lineage-candidates'
import type { Worktree } from '../shared/worktree/types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../shared/worktree/id'
import { isFolderRepo } from '../shared/repo-kind'
import { projectResolvedWorktreeLineage } from '../shared/resolved-worktree-lineage'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { mergeWorktree } from './ipc/worktree-metadata-merge'
import { resolveRepoOwnershipEvidence } from './ipc/worktrees/listing/worktree-host-ownership'
import {
  getFolderWorkspaceInstanceIdentity,
  getFolderWorkspaceRootId,
  isFolderWorkspaceIdForRepo,
  mergeFolderWorkspace
} from './ipc/worktrees/folder-workspace-model'

/** Project a per-repo publication against connected peers in this store. */
export function projectWorktreeLineageWithHostPeers<T extends Worktree>(
  store: CandidateStore,
  rows: readonly T[]
) {
  const snapshot = getWorktreeLineageCandidates(store)
  const { lineageById, folders } = snapshot
  const ownedRows = rows.map((row) => {
    const owners = snapshot.reposById.get(row.repoId) ?? []
    return !row.hostId && owners.length === 1
      ? { ...row, hostId: getRepoExecutionHostId(owners[0]) }
      : row
  })
  const ownRows = new Set(ownedRows.map((row) => composeWorktreeHostIdentity(row.hostId, row.id)))
  const relatedIds = snapshot.relatedIds(rows.map((row) => row.id))
  const legacyMeta = snapshot.rawMetadata
  const peers: Worktree[] = []
  for (const id of relatedIds) {
    const owners = snapshot.reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    const evidence = owners.map(resolveRepoOwnershipEvidence)
    if (evidence.some((owner) => owner.status !== 'owned')) {
      continue
    }
    for (const owner of owners) {
      const ownerHostId = getRepoExecutionHostId(owner)
      if (ownRows.has(composeWorktreeHostIdentity(ownerHostId, id))) {
        continue
      }
      const legacy = legacyMeta[id]
      const meta =
        snapshot.metadataByIdentity.get(composeWorktreeHostIdentity(ownerHostId, id)) ??
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
  return projectResolvedWorktreeLineage(
    ownedRows,
    lineageById,
    [...folders, ...peers],
    legacyMeta
  ).map((row, index) => ({ ...row, hostId: rows[index].hostId }))
}
