import { removeOwnedWorktreeMetadata } from './worktree-metadata-removal'
import {
  initializeCanonicalLineage,
  ownedLineageEdges,
  refreshLegacyLineage,
  removeCanonicalLineage,
  writeCanonicalLineage
} from './canonical-workspace-lineage'
import {
  edgeToWorktreeLineage,
  workspaceLineageToEdge,
  worktreeLineageToEdge
} from '../../../shared/worktree/lineage-edge'
import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type {
  LineageEdge,
  WorkspaceLineage,
  WorktreeLineage
} from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Repo } from '../../../shared/repo-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { scheduleSave } from './write-scheduling'

import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../tracking-repos/worktree-identity-migration'
import {
  getAllWorktreeMetaForHost as getAllWorktreeMetaForHostOperation,
  getWorktreeMetaForHost as getWorktreeMetaForHostOperation,
  migrateWorktreeMetadataLocator,
  setWorktreeMetaForHost as setWorktreeMetaForHostOperation
} from './worktree-identity-metadata'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import {
  captureNativeLocalWorktreeMetadataScanExpectation as captureNativeLocalWorktreeMetadataScanExpectationOperation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo as pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation,
  selectProbeableLocalWorktreeMetadataCandidates as selectProbeableLocalWorktreeMetadataCandidatesOperation,
  type LocalWorktreeMetadataPruneExpectation,
  type NativeLocalWorktreeMetadataScanExpectation
} from '../tracking-repos/missing-local-worktree-metadata-pruning'

export type LineageSnapshot = {
  stored: readonly LineageEdge[]
  owned: readonly LineageEdge[]
  incident: Pick<ReadonlyMap<string, readonly LineageEdge[]>, 'get'>
}
type MetadataLineageOperationsRuntime = Pick<
  StoreRuntimeState,
  'state' | 'lineageSnapshot' | 'durableMutationPhase'
>

const metadataLineageOperationsContext = Symbol('MetadataLineageOperations')
type MetadataLineageOperationsContext = {
  runtime: MetadataLineageOperationsRuntime
  scheduling: WriteSchedulingOperations
  sessions: SessionHostPartitionOperations
}

export class MetadataLineageOperations {
  readonly [metadataLineageOperationsContext]: MetadataLineageOperationsContext

  constructor(
    runtime: MetadataLineageOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    sessions: SessionHostPartitionOperations
  ) {
    this[metadataLineageOperationsContext] = { runtime, scheduling, sessions }
  }
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined {
    return this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]
  }

  getWorktreeMetaForHost(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): WorktreeMeta | undefined {
    return getWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      this[metadataLineageOperationsContext].scheduling,
      worktreeId,
      executionHostId
    )
  }

  setWorktreeMetaForHost(
    worktreeId: string,
    executionHostId: ExecutionHostId,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ): WorktreeMeta {
    const updated = setWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      this[metadataLineageOperationsContext].scheduling,
      worktreeId,
      executionHostId,
      meta
    )
    refreshLegacyLineage(this[metadataLineageOperationsContext].runtime.state)
    return updated
  }

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeMeta
  }

  getAllWorktreeMetaForHost(executionHostId: ExecutionHostId): Record<string, WorktreeMeta> {
    return getAllWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      executionHostId
    )
  }

  captureNativeLocalWorktreeMetadataScanExpectation(
    repo: Repo
  ): NativeLocalWorktreeMetadataScanExpectation {
    return captureNativeLocalWorktreeMetadataScanExpectationOperation(
      this[metadataLineageOperationsContext].runtime.state,
      repo
    )
  }

  setWorktreeMeta(
    worktreeId: string,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ): WorktreeMeta {
    const state = this[metadataLineageOperationsContext].runtime.state
    const stored = state.worktreeMeta[worktreeId]
    const executionHostId = meta.hostId ?? stored?.hostId
    if (executionHostId) {
      return this.setWorktreeMetaForHost(worktreeId, executionHostId, meta)
    }
    const updated = mergeWorktreeMetaForWrite(stored, meta)
    state.worktreeMeta[worktreeId] = updated
    refreshLegacyLineage(state)
    scheduleSave(this[metadataLineageOperationsContext].scheduling, ['worktreeMeta'])
    return updated
  }

  removeWorktreeMeta(worktreeId: string, hostId?: ExecutionHostId | null): void {
    const { runtime, scheduling, sessions } = this[metadataLineageOperationsContext]
    removeOwnedWorktreeMetadata(runtime, scheduling, sessions, worktreeId, hostId)
  }

  selectProbeableLocalWorktreeMetadataCandidates(
    scan: NativeLocalWorktreeMetadataScanExpectation
  ): readonly LocalWorktreeMetadataPruneExpectation[] {
    return selectProbeableLocalWorktreeMetadataCandidatesOperation(
      this[metadataLineageOperationsContext].runtime.state,
      scan
    )
  }

  pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    scan: NativeLocalWorktreeMetadataScanExpectation,
    missingMetadata: readonly LocalWorktreeMetadataPruneExpectation[]
  ): string[] {
    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation(
      this[metadataLineageOperationsContext].runtime.state,
      scan,
      missingMetadata
    )
    if (removed.length > 0) {
      scheduleSave(this[metadataLineageOperationsContext].scheduling)
    }
    return removed
  }

  getLineageSnapshot(): LineageSnapshot {
    const { runtime } = this[metadataLineageOperationsContext]
    if (!runtime.durableMutationPhase && runtime.lineageSnapshot) {
      return runtime.lineageSnapshot
    }
    const state = runtime.state
    if (state.lineageByChildInstance === undefined) {
      initializeCanonicalLineage(state)
    }
    const freeze = (edge: LineageEdge) =>
      Object.freeze({
        ...edge,
        child: Object.freeze({ ...edge.child }),
        parent: Object.freeze({ ...edge.parent }),
        capture: Object.freeze({ ...edge.capture })
      })
    const stored = Object.freeze(Object.values(state.lineageByChildInstance ?? {}).map(freeze))
    const owned = Object.freeze(stored.length ? ownedLineageEdges(state).map(freeze) : [])
    const slices = new Map<string, LineageEdge[]>()
    for (const edge of owned) {
      for (const key of new Set(
        [edge.child.locator, edge.parent.locator]
          .filter((locator) => locator.startsWith('worktree:'))
          .map((locator) =>
            JSON.stringify([locator.slice('worktree:'.length).split('::')[0], edge.child.hostId])
          )
      )) {
        const slice = slices.get(key) ?? []
        slice.push(edge)
        slices.set(key, slice)
      }
    }
    for (const slice of slices.values()) {
      Object.freeze(slice)
    }
    const incident = Object.freeze({ get: slices.get.bind(slices) })
    const snapshot = Object.freeze({ stored, owned, incident })
    if (!runtime.durableMutationPhase) {
      runtime.lineageSnapshot = snapshot
    }
    return snapshot
  }

  getLineageEdges(mode?: 'stored') {
    const snapshot = this.getLineageSnapshot()
    return mode === 'stored' ? snapshot.stored : snapshot.owned
  }

  getRepoLineageEdges(repo: Repo) {
    return (
      this.getLineageSnapshot().incident.get(
        JSON.stringify([repo.id, getRepoExecutionHostId(repo)])
      ) ?? []
    )
  }

  getWorktreeLineage(worktreeId: string, instanceId?: string): WorktreeLineage | undefined {
    if (instanceId) {
      const edge = this.getLineageEdges().find((edge) => edge.child.instanceId === instanceId)
      return edge ? edgeToWorktreeLineage(edge) : undefined
    }
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId]
  }

  getAllWorktreeLineage(): Record<string, WorktreeLineage> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById
  }

  setWorktreeLineage(_worktreeId: string, lineage: WorktreeLineage): WorktreeLineage {
    const edge = worktreeLineageToEdge(lineage)
    if (edge) {
      writeCanonicalLineage(this[metadataLineageOperationsContext].runtime.state, edge)
    }
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }

  removeWorktreeLineage(worktreeId: string, instanceId?: string): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    removeCanonicalLineage(state, instanceId ?? state.worktreeMeta[worktreeId]?.instanceId)
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }

  migrateWorktreeIdentity(
    oldWorktreeId: string,
    newWorktreeId: string,
    executionHostId?: ExecutionHostId
  ): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    const persistedOwner = state.worktreeMeta[oldWorktreeId]?.hostId
    const mover = executionHostId ?? persistedOwner ?? LOCAL_EXECUTION_HOST_ID
    const legacyChanged =
      executionHostId !== undefined &&
      persistedOwner !== undefined &&
      persistedOwner !== executionHostId
        ? false
        : migrateWorktreeIdentityOperation(state, oldWorktreeId, newWorktreeId)
    const canonicalChanged = migrateWorktreeMetadataLocator(
      state,
      oldWorktreeId,
      newWorktreeId,
      mover
    )
    refreshLegacyLineage(state)
    if (legacyChanged || canonicalChanged) {
      // Legacy identity moves also re-key sessions, lineage, mobile selections, and UI state.
      scheduleSave(this[metadataLineageOperationsContext].scheduling, undefined)
    }
  }

  getWorkspaceLineage(childWorkspaceKey: WorkspaceKey): WorkspaceLineage | undefined {
    return this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
      childWorkspaceKey
    ]
  }

  getAllWorkspaceLineage(): Record<WorkspaceKey, WorkspaceLineage> {
    return this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey
  }

  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    const edge = workspaceLineageToEdge(lineage)
    if (edge) {
      writeCanonicalLineage(this[metadataLineageOperationsContext].runtime.state, edge)
    }
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }

  removeWorkspaceLineage(childWorkspaceKey: WorkspaceKey, instanceId?: string): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    removeCanonicalLineage(
      state,
      instanceId ??
        state.workspaceLineageByChildKey[childWorkspaceKey]?.childInstanceId ??
        undefined
    )
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }
}

export function removeWorkspaceLineageForFolderParent(
  owner: MetadataLineageOperations,
  folderWorkspaceId: string
): void {
  // Parent removal leaves child-owned edges inert.
  void owner
  void folderWorkspaceId
}
