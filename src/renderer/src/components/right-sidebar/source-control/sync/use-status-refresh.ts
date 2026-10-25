import { useCallback, useEffect } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import {
  resolveWorktreeGitCopyNow,
  useWorktreeGitCopyHostId,
  worktreeCopyPushTarget
} from '@/lib/worktree-git-copy'
import { getLocalPathOpenOwnerForRoute, isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'
import {
  beginHugeRepoWarningProbe,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control-huge-repo-warning-dismissals'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { PullRequestGenerationContext } from '@/store/slices/pull-request-generation'
import { refreshGitStatusForWorktree } from '../../git-status-refresh'

export type SourceControlStatusRefresh = {
  refreshActiveGitStatus: (signal?: AbortSignal) => Promise<void>
  refreshActiveGitStatusAfterMutation: () => Promise<void>
  refreshGitStatusAfterPullRequestGeneration: (
    context: PullRequestGenerationContext
  ) => Promise<void>
}

export function useSourceControlStatusRefresh({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  activePushTarget,
  isFolder,
  repositoryHuge,
  activeConnectionId,
  activeWorktreeInstanceId
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  activePushTarget?: GitPushTarget
  isFolder: boolean
  repositoryHuge: { limit: number } | null | undefined
  activeConnectionId: string | null
  activeWorktreeInstanceId?: string
}): SourceControlStatusRefresh {
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const activeCopyHostId = useWorktreeGitCopyHostId(activeWorktreeId)
  // Why: activeRepoTarget is pinned to the repo owner's runtime.
  const localIgnoreBlocked = isLocalPathOpenBlocked(
    getLocalPathOpenOwnerForRoute({
      runtimeEnvironmentId:
        activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null,
      connectionId: activeConnectionId
    })
  )
  const refreshActiveGitStatus = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!activeWorktreeId || !worktreePath || isFolder || !activeRepoTarget) {
        return
      }
      // Why the captured host: a mutation callback can outlive a switch to a same-path twin.
      const copy = resolveWorktreeGitCopyNow(activeWorktreeId, activeCopyHostId)
      if (!copy) {
        return
      }
      await refreshGitStatusForWorktree({
        target: copy.transport,
        ownerHostId: copy.hostId,
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: copy.connectionId,
        pushTarget: activePushTarget,
        deps: {
          setGitStatus,
          updateWorktreeGitIdentity,
          setUpstreamStatus,
          fetchUpstreamStatus
        },
        request: { admissionTier: 'interactive', ...(signal ? { signal } : {}) }
      })
    },
    [
      activeCopyHostId,
      activeRepoTarget,
      activeWorktreeId,
      activePushTarget,
      fetchUpstreamStatus,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity,
      worktreePath
    ]
  )
  const refreshActiveGitStatusAfterMutation = useCallback(async (): Promise<void> => {
    try {
      await refreshActiveGitStatus()
    } catch (error) {
      console.warn('[SourceControl] post-mutation git status refresh failed', error)
    }
  }, [refreshActiveGitStatus])

  // Why: when status is truncated, offer once per worktree to .gitignore the flooding folder; desktop-only since the probe and write run on this machine, and managed repos have no connectionId.
  useEffect(() => {
    if (!repositoryHuge || !activeWorktreeId || !worktreePath || localIgnoreBlocked) {
      return
    }
    const warningProbe = beginHugeRepoWarningProbe({
      id: activeWorktreeId,
      instanceId: activeWorktreeInstanceId
    })
    if (hasDismissedHugeRepoWarning(warningProbe)) {
      return
    }
    let cancelled = false
    void window.api.git
      .findHugeFoldersToIgnore({ worktreePath })
      .then((folders) => {
        if (cancelled || folders.length === 0 || hasDismissedHugeRepoWarning(warningProbe)) {
          return
        }
        if (!markHugeRepoWarningDismissed(warningProbe)) {
          return
        }
        const folderName = folders[0]
        toast.warning(
          translate(
            'auto.components.right.sidebar.SourceControl.hugeRepoIgnorePrompt',
            'This repository has too many active changes. Add "{{value0}}" to .gitignore?',
            { value0: folderName }
          ),
          {
            action: {
              label: translate(
                'auto.components.right.sidebar.SourceControl.hugeRepoIgnoreAction',
                'Add to .gitignore'
              ),
              onClick: () => {
                // Why: the toast can outlive its worktree; a purged probe must not write .gitignore in a same-path replacement.
                if (!hasDismissedHugeRepoWarning(warningProbe)) {
                  return
                }
                void window.api.git
                  .appendGitignore({ worktreePath, folderName })
                  .then(() => refreshActiveGitStatus())
                  .catch((error) => console.warn('[SourceControl] add to .gitignore failed', error))
              }
            }
          }
        )
      })
      .catch((error) => console.warn('[SourceControl] findHugeFoldersToIgnore failed', error))
    return () => {
      cancelled = true
    }
  }, [
    repositoryHuge,
    activeWorktreeId,
    activeWorktreeInstanceId,
    worktreePath,
    localIgnoreBlocked,
    refreshActiveGitStatus
  ])

  const refreshGitStatusAfterPullRequestGeneration = useCallback(
    async (context: PullRequestGenerationContext): Promise<void> => {
      if (!context.worktreeId || isFolder) {
        return
      }
      try {
        await refreshGitStatusForWorktree({
          // Why: generation can finish after a host switch; refresh the host that owned the generation request.
          target: context.runtimeTarget,
          ownerHostId: context.ownerHostId ?? null,
          worktreeId: context.worktreeId,
          worktreePath: context.worktreePath,
          connectionId: context.connectionId,
          pushTarget: worktreeCopyPushTarget(
            useAppStore.getState(),
            context.worktreeId,
            context.ownerHostId ?? null
          ),
          deps: {
            setGitStatus,
            updateWorktreeGitIdentity,
            setUpstreamStatus,
            fetchUpstreamStatus
          }
        })
      } catch (error) {
        console.warn('[SourceControl] post-generation git status refresh failed', error)
      }
    },
    [fetchUpstreamStatus, isFolder, setGitStatus, setUpstreamStatus, updateWorktreeGitIdentity]
  )

  return {
    refreshActiveGitStatus,
    refreshActiveGitStatusAfterMutation,
    refreshGitStatusAfterPullRequestGeneration
  }
}
