import { useAppStore } from '@/store'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { getHiddenExternalWorktrees } from '../../../../shared/external-worktree-inbox'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

// The deepest checkout containing the picked folder, else the primary.
export function getProjectInitialCheckout<T extends Worktree>(
  worktrees: readonly T[],
  selectedPath?: string
): T | null {
  const selected = selectedPath
    ? worktrees
        .filter((worktree) => relativePathInsideRoot(worktree.path, selectedPath) !== null)
        .sort((left, right) => right.path.length - left.path.length)[0]
    : undefined
  return selected ?? worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

export function getProjectWorktreesForHost<T extends Worktree>(
  worktrees: readonly T[],
  executionHostId?: ExecutionHostId
): T[] {
  if (!executionHostId) {
    return [...worktrees]
  }
  const parsedHost = parseExecutionHostId(executionHostId)
  return worktrees.filter((worktree) => {
    if (parsedHost?.kind === 'runtime') {
      if (worktree.runtimeOwnerEnvironmentId) {
        return worktree.runtimeOwnerEnvironmentId === parsedHost.environmentId
      }
      // Colliding repo IDs may carry only hostId, so match runtime-qualified hosts too.
      return worktree.hostId === executionHostId
    }
    if (worktree.runtimeOwnerEnvironmentId) {
      return false
    }
    if (worktree.hostId) {
      return worktree.hostId === executionHostId
    }
    return executionHostId === 'local'
  })
}

export function ownerRefreshOptions(executionHostId?: ExecutionHostId) {
  return {
    requireAuthoritative: true as const,
    ...(executionHostId ? { executionHostId } : {})
  }
}

export async function showAllExternalWorktrees(
  repoId: string,
  executionHostId?: ExecutionHostId
): Promise<boolean> {
  const state = useAppStore.getState()
  return executionHostId
    ? state.updateRepo(repoId, { externalWorktreeVisibility: 'show' }, { hostId: executionHostId })
    : state.updateRepo(repoId, { externalWorktreeVisibility: 'show' })
}

export function countHiddenSiblingWorkspaces(
  detected: DetectedWorktreeListResult | undefined,
  executionHostId?: ExecutionHostId,
  selectedPath?: string
): number {
  if (detected?.authoritative !== true) {
    return 0
  }
  const worktrees = getProjectWorktreesForHost(detected.worktrees, executionHostId)
  const chosen = getProjectInitialCheckout(worktrees, selectedPath)
  // The hint's population minus the checkout this handoff opens, so a hidden primary still counts.
  return getHiddenExternalWorktrees({ ...detected, worktrees }).filter(
    (worktree) => worktree.path !== chosen?.path
  ).length
}

// Control arm of the workspace discovery experiments: the pre-experiment reveal-all handoff.
export async function revealDetectedHiddenLinkedExternalWorktrees(
  repoId: string,
  executionHostId?: ExecutionHostId,
  selectedPath?: string
): Promise<DefaultCheckoutHandoffReason | null> {
  const detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
  if (countHiddenSiblingWorkspaces(detected, executionHostId, selectedPath) === 0) {
    return null
  }
  if (!(await showAllExternalWorktrees(repoId, executionHostId))) {
    return 'show_detected_linked_failed'
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  return refreshed ? null : 'linked_external_refresh_failed'
}
