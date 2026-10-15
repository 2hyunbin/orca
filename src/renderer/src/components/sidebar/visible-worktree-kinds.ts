import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  isSleepingSweepExempt,
  isSleepingSweepExemptionNarrowingList as isExemptionNarrowing
} from '../../../../shared/workspace-view/workspace-row-filters'

export {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from '../../../../shared/workspace-view/workspace-row-kinds'

/** Whether the "Hide sleeping" sweep must keep this row (#8873); see isSleepingSweepExempt. */
export function isSleepingSweepExemptWorkspace(
  worktree: Pick<Worktree, 'isMainWorktree'>,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return isSleepingSweepExempt(worktree.isMainWorktree, alwaysShowDefaultBranchWorkspace)
}

/** Whether the exemption being off narrows the list; takes the store's positive sleeping flag. */
export function isSleepingSweepExemptionNarrowingList(
  showSleepingWorkspaces: boolean,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return isExemptionNarrowing(!showSleepingWorkspaces, alwaysShowDefaultBranchWorkspace)
}

/** Inputs describing sidebar filter settings that the Clear Filters path owns. */
export type SidebarFilterState = {
  showSleepingWorkspaces: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep; absent means on. */
  alwaysShowDefaultBranchWorkspace?: boolean
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No workspaces found" message with no in-sidebar recovery path.
 */
