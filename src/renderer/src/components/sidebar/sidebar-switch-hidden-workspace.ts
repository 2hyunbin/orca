import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  isHiddenByWorkspaceKindSwitch,
  type WorkspaceKindSwitches
} from '../../../../shared/worktree/workspace-kinds'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { isSleepingSweepExemptWorkspace } from './visible-worktree-kinds'
import {
  isFolderWorkspaceFromOtherDevice,
  isWorkspaceFromOtherDevice
} from './workspace-creator-visibility'
import type { VisibleWorktreeOptions } from './visible-worktrees'

/** The Filters-menu switches; the search box, project and host filters are not among them. */
export type SidebarSwitchInputs = Pick<
  VisibleWorktreeOptions,
  | 'showSleepingWorkspaces'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'browserTabsByWorktree'
  | 'worktreeIdsWithLiveAgent'
  | 'worktreeIdsWithStructuredChat'
  | 'hideDefaultBranchWorkspace'
  | 'hideAutomationGeneratedWorkspaces'
  | 'hideCliCreatedWorkspaces'
  | 'hideDetachedHeadWorkspaces'
  | 'hideWorkspacesFromOtherDevices'
  | 'pairedDeviceIdsByEnvironment'
>

type SidebarSwitches = WorkspaceKindSwitches &
  Pick<SidebarSwitchInputs, 'showSleepingWorkspaces' | 'hideWorkspacesFromOtherDevices'>

// Why a full Record: a switch added to WorkspaceKindSwitches fails to compile here until listed.
function hideSwitchValues(switches: SidebarSwitches): Record<keyof SidebarSwitches, boolean> {
  return {
    showSleepingWorkspaces: !switches.showSleepingWorkspaces,
    hideDefaultBranchWorkspace: switches.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: switches.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: switches.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: switches.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices: switches.hideWorkspacesFromOtherDevices
  }
}

/** Whether any Filters-menu switch is hiding something; when none is, no row can be hidden. */
export function anySidebarSwitchIsOn(switches: SidebarSwitches): boolean {
  return Object.values(hideSwitchValues(switches)).some(Boolean)
}

/** Whether a switch in the sidebar's Filters menu hides this git workspace row. */
export function isHiddenBySidebarSwitch(
  worktree: Worktree,
  repo: Repo | undefined,
  inputs: SidebarSwitchInputs
): boolean {
  if (
    inputs.hideWorkspacesFromOtherDevices &&
    isWorkspaceFromOtherDevice(worktree, inputs.pairedDeviceIdsByEnvironment)
  ) {
    return true
  }
  if (isHiddenByWorkspaceKindSwitch(worktree, repo, inputs)) {
    return true
  }
  // Why no hideDefaultBranchWorkspace term: the kind switch above already won over the exemption.
  return (
    !inputs.showSleepingWorkspaces &&
    !isSleepingSweepExemptWorkspace(worktree, inputs.alwaysShowDefaultBranchWorkspace) &&
    isInactiveWorkspace(
      worktree.id,
      inputs.tabsByWorktree,
      inputs.ptyIdsByTabId,
      inputs.browserTabsByWorktree,
      inputs.worktreeIdsWithLiveAgent,
      inputs.worktreeIdsWithStructuredChat
    )
  )
}

/** Folder rows answer only the other-client switch; the rest never hide them (use-host-visible-scope). */
export function isFolderWorkspaceHiddenBySidebarSwitch(
  workspace: FolderWorkspace,
  inputs: Pick<
    SidebarSwitchInputs,
    'hideWorkspacesFromOtherDevices' | 'pairedDeviceIdsByEnvironment'
  >
): boolean {
  return (
    inputs.hideWorkspacesFromOtherDevices &&
    isFolderWorkspaceFromOtherDevice(workspace, inputs.pairedDeviceIdsByEnvironment)
  )
}
