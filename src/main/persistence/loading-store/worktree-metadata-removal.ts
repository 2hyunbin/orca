import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import {
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { scheduleSave } from './write-scheduling'
import { removeOwnedLineage, refreshLegacyLineage } from './canonical-workspace-lineage'
import { removeWorktreeMetadataForHost } from './worktree-identity-metadata'
import {
  hasPersistedWorkspaceSession,
  partitionOwnsWorktreeTabs,
  partitionHasOtherRepoWorktreeTabs,
  removeWorkspaceSessionOwnerInPartition,
  type SessionHostPartitionOperations
} from './session-host-partitions'

export function removeOwnedWorktreeMetadata(
  runtime: Pick<StoreRuntimeState, 'state'>,
  scheduling: WriteSchedulingOperations,
  sessions: SessionHostPartitionOperations,
  worktreeId: string,
  hostId?: ExecutionHostId | null
): void {
  // A host-qualified removal names the owner; the persisted host is the fallback.
  const persistedOwner = runtime.state.worktreeMeta[worktreeId]?.hostId
  const owner = hostId ?? persistedOwner
  const preservesDifferentPersistedOwner = Boolean(
    hostId && persistedOwner && persistedOwner !== hostId
  )
  const ownerPartition = workspaceSessionOwnerPartitionForHost(owner)
  const preservesSameIdSessionOwner = Boolean(
    preservesDifferentPersistedOwner ||
    (owner &&
      hasWorktreeRemovalRepoOwnerOnOtherHost(
        { getRepos: () => runtime.state.repos },
        getRepoIdFromWorktreeId(worktreeId),
        ownerPartition
      ))
  )
  removeOwnedLineage(runtime.state, worktreeId, hostId ?? undefined)
  // Mirror the legacy delete's scope below: a full removal takes every host's identity rows,
  // otherwise the surviving owner keeps its own.
  removeWorktreeMetadataForHost(
    runtime.state,
    worktreeId,
    hostId === undefined ? undefined : (hostId ?? undefined)
  )
  // Skip partitions main never wrote: materializing one fences every sibling worktree of the repo.
  const partitions = new Set<ExecutionHostId>(
    workspaceSessionPartitionIdsForHost(owner).filter(
      (partition) =>
        hasPersistedWorkspaceSession(sessions, partition) &&
        // The local partition can be a remote spill surface or a same-id owner.
        // Preserve it whenever another owner may still use the bare id.
        (!preservesSameIdSessionOwner || partition === ownerPartition)
    )
  )
  // A repo-wide fence must not rebase a sibling's unpersisted tabs onto main's copy, and a spill
  // partition that never held this worktree has no claim on the repo at all.
  const fencedPartitions = new Set(
    [...partitions].filter(
      (partition) =>
        partitionOwnsWorktreeTabs(sessions, worktreeId, partition) ||
        (partition === ownerPartition &&
          !partitionHasOtherRepoWorktreeTabs(sessions, worktreeId, partition))
    )
  )
  if (!preservesDifferentPersistedOwner) {
    delete runtime.state.worktreeMeta[worktreeId]
    refreshLegacyLineage(runtime.state)
  }
  for (const partition of partitions) {
    removeWorkspaceSessionOwnerInPartition(sessions, worktreeId, partition, {
      advanceTerminalTopologyRevision: fencedPartitions.has(partition)
    })
  }
  // Why: dropping a row can free the identity key that was vetoing an unrelated row's removal, so
  // the metadata prune needs to look again — it is otherwise waiting on evidence (#17775).
  invalidateLocalWorktreeMetadataPruneInputs()
  scheduleSave(scheduling)
}
