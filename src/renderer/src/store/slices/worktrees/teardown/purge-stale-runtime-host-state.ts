import { beginEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { planStaleRuntimeHostPurge } from './stale-runtime-host-purge-plan'
import { buildFullWorktreePurgeState } from './worktree-purge-state'
import { removeWorktreeVisitEntriesForTargets } from '@/lib/worktree-visit-recency'
import { settleAttentionRemovedBy } from '../../workspace-attention/attention-removal-follow-up'
import { flushRemovalPendingEdits } from '@/components/editor/removal-unsaved-editor-files'
import { fullPurgeFileIds } from './worktree-purge-doomed-ids'

export function createPurgeStaleRuntimeHostState(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['purgeStaleRuntimeHostState'] {
  const purge: WorktreeSlice['purgeStaleRuntimeHostState'] = (removedEnvironmentIds) => {
    const removed = new Set(removedEnvironmentIds)
    if (removed.size === 0) {
      return
    }
    // Why before the purge: delayed editor views must commit text the purge may offer back.
    const state = get()
    const plan = planStaleRuntimeHostPurge(state, removed)
    flushRemovalPendingEdits(
      state,
      fullPurgeFileIds(state, new Set(plan.purgeTargets.map((t) => t.id)))
    )
    // Why no flag settle: the purged host's rows are dropped here, and a surviving same-id row on
    // another host must keep its own flag (a marker-less Mark as unread included).
    settleAttentionRemovedBy(
      set,
      get,
      () =>
        set((s) => {
          const {
            survivingRepoIds,
            survivingRepos,
            reposChanged,
            survivingSetups,
            setupsChanged,
            projectGroups,
            folderWorkspaces,
            groupsChanged,
            worktreeDrop,
            detectedDrop,
            worktreesChanged,
            detectedChanged,
            removedWorktreeTargets,
            removedWorktreeIds,
            purgeTargets,
            survivingRestoredSessionOwners
          } = planStaleRuntimeHostPurge(s, removed)
          // Why full: survivor ids were dropped above unless the session partition proves the bare-id state is the removed host's.
          const purgeState =
            purgeTargets.length > 0 ? buildFullWorktreePurgeState(s, purgeTargets) : {}
          const visitPurgeTargets = [
            ...removedWorktreeTargets,
            ...purgeTargets.filter(
              (target) => !removedWorktreeTargets.some((candidate) => candidate.id === target.id)
            )
          ]
          const nextLastVisitedAtByWorktreeId = removeWorktreeVisitEntriesForTargets(
            s.lastVisitedAtByWorktreeId,
            visitPurgeTargets
          )
          if (nextLastVisitedAtByWorktreeId !== s.lastVisitedAtByWorktreeId) {
            purgeState.lastVisitedAtByWorktreeId = nextLastVisitedAtByWorktreeId
          }

          const restoredSessionOwnersChanged =
            survivingRestoredSessionOwners !== s.restoredRuntimeHostIdByWorkspaceSessionKey
          let survivingVisibilityDefaults = s.worktreeVisibilityDefaultsByHost
          for (const environmentId of removed) {
            const hostId = toRuntimeExecutionHostId(environmentId)
            if (hostId in survivingVisibilityDefaults) {
              if (survivingVisibilityDefaults === s.worktreeVisibilityDefaultsByHost) {
                survivingVisibilityDefaults = { ...survivingVisibilityDefaults }
              }
              delete survivingVisibilityDefaults[hostId]
            }
          }
          const visibilityDefaultsChanged =
            survivingVisibilityDefaults !== s.worktreeVisibilityDefaultsByHost
          const visibilitySupportChanged = removed.has(
            s.worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId ?? ''
          )
          const visibilitySourceSupportChanged = removed.has(
            s.worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId ?? ''
          )
          if (
            !reposChanged &&
            !setupsChanged &&
            !groupsChanged &&
            !worktreesChanged &&
            !detectedChanged &&
            !restoredSessionOwnersChanged &&
            !visibilityDefaultsChanged &&
            !visibilitySupportChanged &&
            !visibilitySourceSupportChanged &&
            removedWorktreeIds.size === 0
          ) {
            return s
          }

          const detectedWorktreesByRepo = detectedChanged
            ? Object.fromEntries(
                Object.entries(s.detectedWorktreesByRepo).map(([repoId, result]) => [
                  repoId,
                  { ...result, worktrees: detectedDrop.rowsByRepo[repoId] }
                ])
              )
            : s.detectedWorktreesByRepo

          const rowsChanged = worktreesChanged || detectedChanged
          return {
            ...purgeState,
            ...(reposChanged ? { repos: survivingRepos } : {}),
            ...(setupsChanged ? { projectHostSetups: survivingSetups } : {}),
            ...(groupsChanged ? { projectGroups, folderWorkspaces } : {}),
            ...(worktreesChanged ? { worktreesByRepo: worktreeDrop.rowsByRepo } : {}),
            ...(detectedChanged ? { detectedWorktreesByRepo } : {}),
            ...(restoredSessionOwnersChanged
              ? { restoredRuntimeHostIdByWorkspaceSessionKey: survivingRestoredSessionOwners }
              : {}),
            ...(visibilityDefaultsChanged
              ? { worktreeVisibilityDefaultsByHost: survivingVisibilityDefaults }
              : {}),
            ...(visibilitySupportChanged
              ? { worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: null }
              : {}),
            ...(visibilitySourceSupportChanged
              ? { worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: null }
              : {}),
            ...(rowsChanged ? { sortEpoch: s.sortEpoch + 1 } : {}),
            // Why: mirror validateRepoScopedUi so a filtered/active sidebar can't reference a purged repo id.
            ...(reposChanged
              ? {
                  activeRepoId:
                    s.activeRepoId && survivingRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
                  filterRepoIds: s.filterRepoIds.filter((repoId) => survivingRepoIds.has(repoId))
                }
              : {})
          }
        }),
      { settleFlags: false }
    )
  }
  return (ids) => {
    const removed = [...ids]
    const finishRemovals = removed.map((id) =>
      beginEnclosingWorktreeRemoval({ hostId: toRuntimeExecutionHostId(id) })
    )
    try {
      purge(removed)
    } finally {
      finishRemovals.forEach((finish) => finish())
    }
  }
}
