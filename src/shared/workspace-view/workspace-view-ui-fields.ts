import type { PersistedUIState } from '../persisted-ui-state-types'

/** The UI state behind the Workspace options, which a host's own phone mirrors. */
export const WORKSPACE_VIEW_UI_FIELDS = [
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'hideSleepingWorkspaces',
  'alwaysShowDefaultBranchWorkspace',
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices',
  'filterRepoIds',
  'visibleWorkspaceHostIds',
  'worktreeCardProperties',
  'agentActivityDisplayMode',
  'collapsedGroups',
  'workspaceStatuses'
] as const satisfies readonly (keyof PersistedUIState)[]

/** The Workspace options values in a fixed order, for change detection. */
export function workspaceViewUiValues(ui: PersistedUIState): unknown[] {
  return WORKSPACE_VIEW_UI_FIELDS.map((key) => ui[key])
}
