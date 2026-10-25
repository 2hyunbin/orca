import type { WorktreeSlice } from '../../worktree-helpers'
import { runtimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import { detachedHeadAutoDerivedDisplayNames } from './detached-head-display-name'
import {
  applyHostedReviewLinkClear,
  canonicalHostedReviewBranchIdentity,
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  getHostedReviewLinkMutationGeneration,
  getHostedReviewLinkUpdates,
  hasBranchScopedHostedReviewContext,
  hostedReviewLinkClearTombstonesByWorktreeId,
  hostedReviewLinksAreCleared,
  rememberHostedReviewLinkClear,
  resolveHostedReviewLinkWorktreeId
} from './hosted-review-link-mutation'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo,
  type WorkspaceRecordState
} from '../../../workspace-record-selectors'

/**
 * The row one host's git answer for `worktreeId` describes. Ids are `repoId::path`, so a same-path
 * twin on another host shares it; with no host named, a twin pair is ambiguous and gets nothing.
 */
function gitIdentityTargetRows(
  state: WorkspaceRecordState,
  worktreeId: string,
  ownerHostId: ExecutionHostId | null
): Set<Worktree> {
  if (ownerHostId) {
    // Why the host target: it also places a paired server's SSH checkout under its `runtime:` alias.
    const row = selectWorkspaceByHostTarget(
      state,
      hostWorktreeTarget({ id: worktreeId, hostId: ownerHostId })
    )
    return new Set(row ? [row] : [])
  }
  const rows = (selectWorktreesByRepo(state)[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
    (worktree) => worktree.id === worktreeId
  )
  return new Set(new Set(rows.map((worktree) => worktree.hostId)).size > 1 ? [] : rows)
}

export function createUpdateWorktreeGitIdentity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeGitIdentity'] {
  return (worktreeId, identity, ownerHostId) => {
    let shouldPersistHostedReviewClear = false
    let clearedBranch: string | null = null
    let clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const nextHeadFor = (worktree: Worktree): string => identity.head ?? worktree.head
    const nextBranchFor = (worktree: Worktree): string =>
      identity.branch === null ? '' : (identity.branch ?? worktree.branch)
    const initialTargets = gitIdentityTargetRows(get(), worktreeId, ownerHostId)
    const anyTargetChanges = [...initialTargets].some(
      (worktree) =>
        nextHeadFor(worktree) !== worktree.head || nextBranchFor(worktree) !== worktree.branch
    )
    if (!anyTargetChanges) {
      return
    }

    set((s) => {
      const current = s.worktreesByRepo[repoId]
      if (!current) {
        return s
      }

      let changed = false
      const targets = gitIdentityTargetRows(s, worktreeId, ownerHostId)
      const next = current.map((worktree) => {
        if (!targets.has(worktree)) {
          return worktree
        }
        const nextHead = nextHeadFor(worktree)
        const nextBranch = nextBranchFor(worktree)
        if (nextHead === worktree.head && nextBranch === worktree.branch) {
          return worktree
        }
        changed = true
        const hostedReviewBranchChanged =
          canonicalHostedReviewBranchIdentity(nextBranch) !==
          canonicalHostedReviewBranchIdentity(worktree.branch)
        const shouldClearHostedReviewContext =
          hostedReviewBranchChanged && hasBranchScopedHostedReviewContext(worktree)
        if (shouldClearHostedReviewContext) {
          shouldPersistHostedReviewClear = true
          clearedBranch = nextBranch
          clearGeneration = getHostedReviewLinkMutationGeneration(worktreeId)
          rememberHostedReviewLinkClear(worktreeId, nextBranch, clearGeneration, nextHead)
        } else {
          const tombstone = hostedReviewLinkClearTombstonesByWorktreeId.get(worktreeId)
          if (tombstone) {
            const nextBranchIdentity = canonicalHostedReviewBranchIdentity(nextBranch)
            hostedReviewLinkClearTombstonesByWorktreeId.set(worktreeId, {
              ...tombstone,
              branch: nextBranch,
              branchIdentity: nextBranchIdentity,
              head: nextHead
            })
            if (hostedReviewBranchChanged) {
              shouldPersistHostedReviewClear = true
              clearedBranch = nextBranch
              clearGeneration = tombstone.generation
            }
          }
        }
        // Why: terminal branch switches only patch branch/head here; re-derive auto titles like full listing does.
        const currentBranchName = branchName(worktree.branch)
        const wasAutoDerived =
          worktree.displayNameMode === 'automatic' ||
          (worktree.displayNameMode === undefined &&
            worktree.cliProvenance?.kind !== 'created-by-cli' &&
            worktree.displayName === currentBranchName)
        const wasDetachedAutoDerived =
          worktree.branch === '' &&
          nextBranch !== '' &&
          detachedHeadAutoDerivedDisplayNames.get(worktreeId) === worktree.displayName
        const nextDisplayName =
          (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
            ? branchName(nextBranch)
            : worktree.displayName
        if (identity.branch === null && wasAutoDerived) {
          detachedHeadAutoDerivedDisplayNames.set(worktreeId, worktree.displayName)
        } else if (identity.branch !== undefined) {
          detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
        }
        return {
          ...worktree,
          head: nextHead,
          branch: nextBranch,
          displayName: nextDisplayName,
          ...(shouldClearHostedReviewContext
            ? normalizeWorkspaceAttachmentUpdate(worktree, CLEARED_HOSTED_REVIEW_LINK_UPDATES)
            : {})
        }
      })

      if (!changed) {
        return s
      }

      return {
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: next },
        sortEpoch: s.sortEpoch + 1
      }
    })
    if (!shouldPersistHostedReviewClear || clearedBranch === null) {
      return
    }

    // Why: the deferred clear must read, clear and persist the copy this answer patched, not its twin.
    const readTargetRow = (id: string) => get().getKnownWorktreeById(id, ownerHostId ?? undefined)
    void Promise.resolve()
      .then(async () => {
        let currentWorktreeId = resolveHostedReviewLinkWorktreeId(worktreeId)
        const persistedWorktreeIds = new Set<string>()
        while (true) {
          currentWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (persistedWorktreeIds.has(currentWorktreeId)) {
            return
          }
          persistedWorktreeIds.add(currentWorktreeId)
          let current = readTargetRow(currentWorktreeId)
          if (
            !current ||
            current.branch !== clearedBranch ||
            getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration
          ) {
            return
          }
          if (!hostedReviewLinksAreCleared(current as Worktree)) {
            // Why: a refetch can rehydrate stale linked-review metadata before this async clear starts; clear it again.
            applyHostedReviewLinkClear(
              set,
              currentWorktreeId,
              readTargetRow(currentWorktreeId)?.hostId
            )
            current = readTargetRow(currentWorktreeId)
            if (!current || current.branch !== clearedBranch) {
              return
            }
          }
          await persistWorktreeMeta(
            runtimeTargetForWorktreeOwner(get(), currentWorktreeId, ownerHostId ?? undefined),
            currentWorktreeId,
            CLEARED_HOSTED_REVIEW_LINK_UPDATES
          )
          const migratedWorktreeId = resolveHostedReviewLinkWorktreeId(currentWorktreeId)
          if (migratedWorktreeId === currentWorktreeId) {
            break
          }
          // Why: worktree creation can migrate ids mid-IPC; persist the clear under the new durable id too.
          currentWorktreeId = migratedWorktreeId
        }
        const latest = readTargetRow(currentWorktreeId)
        if (
          !latest ||
          latest.branch !== clearedBranch ||
          hostedReviewLinksAreCleared(latest as Worktree)
        ) {
          return
        }
        if (getHostedReviewLinkMutationGeneration(currentWorktreeId) !== clearGeneration) {
          // Why: a delayed branch-switch clear must not win over a newer manual relink.
          await persistWorktreeMeta(
            runtimeTargetForWorktreeOwner(get(), currentWorktreeId, ownerHostId ?? undefined),
            currentWorktreeId,
            getHostedReviewLinkUpdates(latest as Worktree)
          )
          return
        }
        // Why: a refetch can rehydrate old metadata before the branch-switch clear reaches disk; don't write the stale link back.
        applyHostedReviewLinkClear(set, currentWorktreeId, readTargetRow(currentWorktreeId)?.hostId)
      })
      .catch((err) => {
        if (isRuntimeSelectorNotFoundError(err)) {
          void get().fetchWorktrees(
            getRepoIdFromWorktreeId(resolveHostedReviewLinkWorktreeId(worktreeId))
          )
          return
        }
        console.error('Failed to persist branch-scoped review link clear:', err)
      })
  }
}
