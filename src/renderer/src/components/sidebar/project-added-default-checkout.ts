import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import { mergeExternalWorktreeInboxPaths } from '../../../../shared/external-worktree-inbox'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import {
  capWorkspaceDiscoveryCount,
  getWorkspaceDiscoveryArm
} from './workspace-discovery-telemetry'
import {
  countHiddenSiblingWorkspaces,
  getProjectInitialCheckout,
  getProjectWorktreesForHost,
  ownerRefreshOptions,
  revealDetectedHiddenLinkedExternalWorktrees,
  showAllExternalWorktrees
} from './project-added-sibling-workspaces'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

export function getProjectDefaultCheckout(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

function getDetectedProjectDefaultCheckout(
  detected: DetectedWorktreeListResult | undefined,
  executionHostId?: ExecutionHostId,
  selectedPath?: string
): DetectedWorktreeListResult['worktrees'][number] | null {
  if (detected?.authoritative !== true) {
    return null
  }
  return (
    getProjectInitialCheckout(
      getProjectWorktreesForHost(detected.worktrees, executionHostId),
      selectedPath
    ) ?? null
  )
}

async function findDetectedDefaultCheckout(
  repoId: string,
  revealSiblings: boolean,
  executionHostId?: ExecutionHostId,
  selectedPath?: string
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const state = useAppStore.getState()
  const detected = selectDetectedWorktreesByRepo(state)[repoId]
  const detectedDefaultCheckout = getDetectedProjectDefaultCheckout(
    detected,
    executionHostId,
    selectedPath
  )
  if (!detectedDefaultCheckout) {
    return {
      worktree: null,
      reason:
        detected?.authoritative === true ? 'no_default_checkout' : 'no_authoritative_detection'
    }
  }
  if (!detectedDefaultCheckout.visible && revealSiblings) {
    if (!(await showAllExternalWorktrees(repoId, executionHostId))) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
  } else if (!detectedDefaultCheckout.visible) {
    const ownerHostId =
      executionHostId ?? getWorktreeExecutionHostId(detectedDefaultCheckout, undefined)
    const matchingRepos = state.repos.filter((candidate) => candidate.id === repoId)
    const repo =
      !executionHostId && matchingRepos.length === 1
        ? matchingRepos[0]
        : matchingRepos.find((candidate) => repoMatchesHostIdentity(candidate, repoId, ownerHostId))
    const updates = {
      importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
        repo?.importedExternalWorktreePaths,
        [detectedDefaultCheckout.path]
      )
    }
    const updated = executionHostId
      ? await state.updateRepo(repoId, updates, { hostId: executionHostId })
      : await state.updateRepo(repoId, updates)
    if (!updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree = getProjectInitialCheckout(
    getProjectWorktreesForHost(
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
      executionHostId
    ),
    selectedPath
  )
  return {
    worktree,
    reason: worktree ? 'detected_default_checkout' : 'refreshed_default_missing'
  }
}

function resolveInitialCwdForDefaultCheckout(
  defaultCheckout: Worktree,
  selectedPath: string | undefined
): string | undefined {
  if (!selectedPath) {
    return undefined
  }
  const relativePath = relativePathInsideRoot(defaultCheckout.path, selectedPath)
  return relativePath && relativePath.length > 0 ? selectedPath : undefined
}

export async function openProjectDefaultCheckout({
  repoId,
  source,
  selectedPath,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  const initialState = useAppStore.getState()
  const revealSiblings = getWorkspaceDiscoveryArm(initialState.settings?.telemetry) === 'control'
  // Measured before either arm changes visibility, so both arms qualify on identical evidence.
  const hiddenSiblingCount = countHiddenSiblingWorkspaces(
    selectDetectedWorktreesByRepo(initialState)[repoId],
    executionHostId,
    selectedPath
  )
  if (hiddenSiblingCount > 0) {
    track('workspace_discovery_eligible', {
      workspace_count: capWorkspaceDiscoveryCount(hiddenSiblingCount)
    })
  }

  let defaultCheckout = getProjectInitialCheckout(
    getProjectWorktreesForHost(
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
      executionHostId
    ),
    selectedPath
  )
  let reason: DefaultCheckoutHandoffReason = 'loaded_default_checkout'
  if (
    !defaultCheckout ||
    (selectedPath && relativePathInsideRoot(defaultCheckout.path, selectedPath) === null)
  ) {
    const detectedDefaultCheckout = await findDetectedDefaultCheckout(
      repoId,
      revealSiblings,
      executionHostId,
      selectedPath
    )
    if (detectedDefaultCheckout.worktree || !defaultCheckout) {
      defaultCheckout = detectedDefaultCheckout.worktree
      reason = detectedDefaultCheckout.reason
    }
  }

  if (defaultCheckout) {
    const revealLinkedFailureReason = revealSiblings
      ? await revealDetectedHiddenLinkedExternalWorktrees(repoId, executionHostId, selectedPath)
      : null
    if (revealLinkedFailureReason) {
      track('add_repo_default_checkout_handoff', {
        source,
        result: 'revealed_project',
        reason: revealLinkedFailureReason
      })
      finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
      return
    }
    // Why: the onboarding handoff should land on the default checkout even
    // when the user normally hides default-branch workspaces in the sidebar.
    const state = useAppStore.getState()
    if (defaultCheckout.isMainWorktree && state.hideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    track('add_repo_default_checkout_handoff', {
      source,
      result: defaultCheckout.isMainWorktree
        ? 'opened_default_checkout'
        : 'opened_selected_checkout',
      reason
    })
    const initialCwd = resolveInitialCwdForDefaultCheckout(defaultCheckout, selectedPath)
    if (initialCwd || executionHostId) {
      activateAndRevealWorktree(defaultCheckout.id, {
        ...(initialCwd ? { initialCwd } : {}),
        ...(executionHostId ? { executionHostId } : {})
      })
    } else {
      activateAndRevealWorktree(defaultCheckout.id)
    }
    return
  }

  track('add_repo_default_checkout_handoff', {
    source,
    result: 'revealed_project',
    reason
  })
  finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
}

export async function finishProjectAddWithDefaultCheckout({
  repoId,
  source,
  selectedPath,
  closeModal,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  closeModal: () => void
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  await markOnboardingProjectAdded('addedRepo')
  closeModal()
  await openProjectDefaultCheckout({
    repoId,
    source,
    selectedPath,
    executionHostId,
    setHideDefaultBranchWorkspace
  })
}
