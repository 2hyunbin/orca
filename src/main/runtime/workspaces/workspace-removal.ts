import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from '../../worktree-removal-repo-owner'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { finishAcceptedWorktreeRemoval } from '../../worktree-background-removal'
import { preservedBranchCleanupScopeKey } from '../../../shared/preserved-branch-cleanup'
import {
  getRuntimeWorktreeRemovalOptionsKey,
  type RemoveManagedWorktreeOptions
} from '../runtime-worktree-selection'
import { withWorktreeSpan } from '../../observability/instrumentation'
import {
  resolveWorktreeRemovalHome,
  resolveWorktreeRemovalRoute
} from '../../worktree-removal-execution-host-route'
import { listWorktreesOnRemovalRoute } from '../worktree-removal-route-listing'
import { isPrunableGitFileWorktree } from '../../worktree-prunable-git-file'
import { findRegisteredDeletableWorktree } from '../../worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from '../runtime-unregistered-worktree-removal'
import { assertWorktreeUnlockedForRemoval } from '../../../shared/worktree/removal'
import { formatWorktreeRemovalError } from '../../ipc/worktree-logic'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isLocalRuntimeWorktreePathMissing } from '../runtime-worktree-filesystem'
import { removeStaleLocalWorktreeRegistration } from '../../local-worktree-removal-recovery'
import { cleanupUnusedWorktreePushTargetRemote } from '../../ipc/worktree-remote'
import { removeRuntimeRegisteredLocalWorktree } from '../runtime-registered-local-worktree-removal'
import { removeOrphanOrFolderWorktree } from './workspace-registration-removal'
import { RuntimeWorktreeRemovalInFlight } from '../runtime-worktree-removal-in-flight'
import type { WorkspaceRemovalHost, WorkspaceRemovalContext } from './workspace-removal-ports'

export class RuntimeWorkspaceRemoval {
  private readonly inFlight = new RuntimeWorktreeRemovalInFlight()
  constructor(private readonly host: WorkspaceRemovalHost) {}
  private get store() {
    return this.host.getStore()
  }
  async removeManagedWorktree(
    worktreeSelector: string,
    options: RemoveManagedWorktreeOptions = {}
  ): Promise<RemoveWorktreeResult & { warning?: string }> {
    const {
      force = false,
      runHooks = false,
      allowUnverifiedPtyStop = false,
      allowFailedArchiveHook = false,
      hostId
    } = options
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const store = this.store
    const cleanupHostId = parseExecutionHostId(hostId)?.id
    const removalTarget = await this.host.resolveWorktreeRemovalTarget(
      worktreeSelector,
      cleanupHostId
    )
    // Why: a retry or a second client asking while Git still deletes joins that removal.
    const pending = this.host.joinPendingWorktreeRemoval(removalTarget.id, options)
    if (pending) {
      return options.waitForBackgroundRemoval ? await pending : { removing: true }
    }
    const emitRemoved = (): void =>
      this.host.emitWorktreeLifecycle({
        kind: 'removed',
        worktreeId: removalTarget.id,
        path: removalTarget.path
      })
    const cleanupScopeKey = preservedBranchCleanupScopeKey({
      worktreeId: removalTarget.id,
      hostId: cleanupHostId
    })
    const optionsKey = getRuntimeWorktreeRemovalOptionsKey({
      force,
      runHooks,
      allowUnverifiedPtyStop,
      allowFailedArchiveHook
    })
    const inFlightRemoval = this.inFlight.get(cleanupScopeKey, removalTarget.id, optionsKey)
    if (inFlightRemoval) {
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(await inFlightRemoval, removalTarget.id, cleanupHostId)
        : inFlightRemoval
    }
    const removal = (async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      return withWorktreeSpan({ stage: 'remove', path: removalTarget.path }, async () => {
        const repoOwner = resolveWorktreeRemovalRepoOwner(
          store,
          removalTarget.repoId,
          cleanupHostId
        )
        if (repoOwner.kind === 'ambiguous') {
          throw new Error(
            `Workspace identity is ambiguous across hosts: ${removalTarget.id}. Retry with an explicit host.`
          )
        }
        const context: WorkspaceRemovalContext =
          repoOwner.kind === 'resolved'
            ? {
                repo: repoOwner.repo,
                removalHostId: cleanupHostId ?? getRepoExecutionHostId(repoOwner.repo)
              }
            : { repo: undefined, removalHostId: cleanupHostId }
        const purgeRemovedWorktree = (): void =>
          this.host.purgeRemovedWorktree(
            store,
            removalTarget.id,
            removalTarget.repoId,
            context.removalHostId
          )
        const orphanOrFolderResult = await removeOrphanOrFolderWorktree({
          runtime: this.host,
          store,
          removalTarget,
          cleanupHostId,
          context
        })
        if (orphanOrFolderResult.kind === 'removed') {
          return orphanOrFolderResult.result
        }
        const { repo, removalHostId } = orphanOrFolderResult
        // One host for the whole removal. Listing on a different host from the one the prune and
        // the delete use is how an `executionHostId: 'ssh:*'`-only row got listed remotely and
        // deleted here; the route refuses rather than falling back to this machine.
        const route = resolveWorktreeRemovalRoute(removalHostId)
        const { localWorktreeGitOptions, registeredWorktrees } = await listWorktreesOnRemovalRoute(
          route,
          repo,
          this.host.requireStore()
        )
        const removedMeta = resolveWorktreeRemovalMetadata(
          store,
          removalTarget.repoId,
          removalTarget.id,
          removalHostId
        )
        const removedPushTarget = removedMeta?.pushTarget ?? removalTarget.pushTarget
        const removalHome = resolveWorktreeRemovalHome(route)
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          removalTarget.path,
          registeredWorktrees,
          removalHome
        )
        if (this.host.retryFailedLocalRemoval(route, removalTarget, registeredWorktrees, options)) {
          return { removing: true }
        }
        if (!registeredWorktree) {
          return removeRuntimeUnregisteredWorktree({
            repo,
            target: removalTarget,
            registeredWorktrees,
            removedMeta,
            removedPushTarget,
            force,
            allowUnverifiedPtyStop,
            route,
            localOptions: localWorktreeGitOptions,
            store,
            acquireWatcherRemoval: this.host.getAcquireFileWatcherRemoval(),
            stopPtys: (worktreeId, allowUnverifiedPtyStop) =>
              this.host.stopPtysForDestructiveWorktreeRemoval(worktreeId, {
                allowUnverifiedStop: allowUnverifiedPtyStop
              }),
            finishRemoval: () => {
              this.host.getPreservedBranchCleanup().delete(removalTarget.id, cleanupHostId)
              purgeRemovedWorktree()
              this.host.notifyWorktreesChanged(repo.id)
            }
          })
        }
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = removedMeta?.preserveBranchOnDelete !== true
        try {
          assertWorktreeUnlockedForRemoval(registeredWorktree)
        } catch (error) {
          throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
        }
        if (
          (await isPrunableGitFileWorktree(registeredWorktree, localWorktreeGitOptions)) ||
          (force === true &&
            process.platform === 'win32' &&
            (isWindowsAbsolutePathLike(canonicalWorktreePath) ||
              !!localWorktreeGitOptions.wslDistro) &&
            removedMeta &&
            (await isLocalRuntimeWorktreePathMissing(
              canonicalWorktreePath,
              localWorktreeGitOptions
            )))
        ) {
          const removalResult = await removeStaleLocalWorktreeRegistration({
            canonicalWorktreePath,
            repoPath: repo.path,
            localWorktreeGitOptions,
            registeredWorktree,
            deleteBranch
          })
          await cleanupUnusedWorktreePushTargetRemote(
            repo.path,
            removalTarget.id,
            removedPushTarget,
            store,
            localWorktreeGitOptions
          )
          this.host
            .getPreservedBranchCleanup()
            .remember(
              removalTarget.id,
              cleanupHostId,
              removalResult,
              registeredWorktree.head,
              removedPushTarget
            )
          purgeRemovedWorktree()
          this.host.notifyWorktreesChanged(repo.id)
          return removalResult ?? {}
        }
        return removeRuntimeRegisteredLocalWorktree({
          repo,
          target: removalTarget,
          registeredWorktree,
          removedPushTarget,
          store,
          localOptions: localWorktreeGitOptions,
          hasLocalOptions: Object.keys(localWorktreeGitOptions).length > 0,
          force,
          runHooks,
          allowFailedArchiveHook,
          allowUnverifiedPtyStop,
          deleteBranch,
          acquireWatcherRemoval: this.host.getAcquireFileWatcherRemoval(),
          stopPtys: () =>
            this.host.stopPtysForDestructiveWorktreeRemoval(removalTarget.id, {
              allowUnverifiedStop: allowUnverifiedPtyStop
            }),
          closeWatchers: (path) => this.host.closeFileWatchersForRemoval(path),
          preserveBranchHead: (result, fallbackHead) =>
            this.host.getPreservedBranchCleanup().preserveHead(result, fallbackHead),
          finishRemoval: (result, rememberBranch, fallbackHead) => {
            if (rememberBranch) {
              this.host
                .getPreservedBranchCleanup()
                .remember(removalTarget.id, cleanupHostId, result, fallbackHead, removedPushTarget)
            } else {
              this.host.getPreservedBranchCleanup().delete(removalTarget.id, cleanupHostId)
            }
            purgeRemovedWorktree()
          },
          onRemoved: emitRemoved,
          publish: () => this.host.publishWorktreeRemovalChange(repo.id)
        })
      })
    })()
    this.inFlight.track(cleanupScopeKey, optionsKey, removal)
    try {
      const accepted = await removal
      // A background removal emits this when Git finishes instead.
      if (!accepted.removing) {
        emitRemoved()
      }
      return options.waitForBackgroundRemoval
        ? finishAcceptedWorktreeRemoval(accepted, removalTarget.id, cleanupHostId)
        : accepted
    } finally {
      this.inFlight.release(cleanupScopeKey, removal)
    }
  }
}
