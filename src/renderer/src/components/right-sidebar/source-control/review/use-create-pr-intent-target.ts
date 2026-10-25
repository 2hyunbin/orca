import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'

/**
 * Tracks what the user is currently looking at so an in-flight Create PR run can tell whether the
 * panel has since moved on, and pins each of the run's git calls to the host it started from.
 */
export function useSourceControlCreatePrIntentTarget({
  activeRepoId,
  activeRepoTarget,
  activeWorktreeId,
  branchName,
  createPrIntentCurrentTargetRef,
  effectiveBaseRef,
  worktreeMap,
  worktreePath
}: {
  activeRepoId: string | null
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  branchName: string
  createPrIntentCurrentTargetRef: SourceControlWorktreeOperationState['createPrIntentCurrentTargetRef']
  effectiveBaseRef: string | null
  worktreeMap: SourceControlWorktreeContext['worktreeMap']
  worktreePath: string | null
}) {
  useEffect(() => {
    createPrIntentCurrentTargetRef.current = {
      repoId: activeRepoId ?? null,
      worktreeId: activeWorktreeId ?? null,
      worktreePath,
      branch: branchName,
      baseRef: effectiveBaseRef ?? null
    }
  }, [
    activeRepoId,
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    effectiveBaseRef,
    worktreePath
  ])

  const getCreatePrIntentOperationTarget = useCallback(
    (token: CreatePrIntentRunToken): SourceControlOperationTarget => {
      // Why: Create PR intent continues after navigation; pin git commands to the worktree copy that started it.
      const copy = token.ownerHostId
        ? resolveWorktreeGitCopyNow(token.worktreeId, token.ownerHostId)
        : null
      return {
        target: copy?.transport ?? activeRepoTarget,
        worktreeId: token.worktreeId,
        worktreePath: token.worktreePath,
        connectionId: copy ? copy.connectionId : (getConnectionId(token.worktreeId) ?? undefined),
        ownerHostId: token.ownerHostId ?? null,
        pushTarget: worktreeMap.get(token.worktreeId)?.pushTarget
      }
    },
    [activeRepoTarget, worktreeMap]
  )

  return { getCreatePrIntentOperationTarget }
}

export type SourceControlCreatePrIntentTarget = ReturnType<
  typeof useSourceControlCreatePrIntentTarget
>
