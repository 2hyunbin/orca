import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
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
    (token: CreatePrIntentRunToken): SourceControlOperationTarget =>
      createPrIntentOperationTarget(token, {
        activeRepoTarget,
        pushTarget: worktreeMap.get(token.worktreeId)?.pushTarget,
        bareConnectionId: getConnectionId
      }),
    [activeRepoTarget, worktreeMap]
  )

  return { getCreatePrIntentOperationTarget }
}

/**
 * Pins a Create PR run's calls to the copy and transport captured when it started, never
 * re-resolved: a copy that did not resolve gets no transport, so the run refuses instead of
 * committing or pushing on a same-path twin's checkout.
 */
export function createPrIntentOperationTarget(
  token: CreatePrIntentRunToken,
  deps: {
    activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
    pushTarget: SourceControlOperationTarget['pushTarget']
    bareConnectionId: (worktreeId: string) => string | null | undefined
  }
): SourceControlOperationTarget {
  const base = {
    worktreeId: token.worktreeId,
    worktreePath: token.worktreePath,
    pushTarget: deps.pushTarget
  }
  if (token.pinnedCopy === undefined) {
    return {
      ...base,
      target: deps.activeRepoTarget,
      connectionId: deps.bareConnectionId(token.worktreeId) ?? undefined,
      ownerHostId: null
    }
  }
  const copy = token.pinnedCopy
  return {
    ...base,
    target: copy?.transport ?? null,
    connectionId: copy?.connectionId,
    ownerHostId: copy?.hostId ?? null
  }
}

export type SourceControlCreatePrIntentTarget = ReturnType<
  typeof useSourceControlCreatePrIntentTarget
>
