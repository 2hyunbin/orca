// Whether this host's own phone push for a structured-chat edge must stay quiet because the
// desktop's sidebar Filters hide the workspace and "Notify About Hidden Workspaces" is off.
//
// WHY NOT "HIDE SLEEPING": main sees the persisted switches and its in-memory workspace records,
// not the renderer's live tabs, so sleeping is left to the renderer; a local chat that raises
// attention is live anyway. Rows here are this host's own, so "Hide other-client" needs no
// paired-device map: any known creator other than the host is another client.
//
// FAILS OPEN: no persisted UI, no record of the workspace, or a workspace with a lineage child (the
// sidebar shows a hidden parent above a visible child) all notify.
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import {
  isCreatedByAnotherClient,
  isHiddenByWorkspaceKindSwitch,
  type WorkspaceKindSwitches
} from '../../shared/worktree/workspace-kinds'
import type { RuntimeStore } from './runtime-store-contract'

export type HiddenWorkspaceAttentionDeps = {
  store: Pick<
    RuntimeStore,
    'getUI' | 'getRepo' | 'getWorktreeMeta' | 'getAllWorktreeLineage' | 'getFolderWorkspaces'
  >
  notificationSettings: NotificationSettings
  /** Last resolved Git listing, possibly stale; branch and HEAD come only from here. */
  resolvedWorktrees: readonly Worktree[] | null
}

export function isStructuredAttentionWorkspaceHidden(
  deps: HiddenWorkspaceAttentionDeps,
  scope: AgentSessionExecutionLocation
): boolean {
  if (deps.notificationSettings.notifyHiddenWorkspaces !== false) {
    return false
  }
  const ui = deps.store.getUI?.()
  if (!ui) {
    return false
  }
  const hideOtherClients = ui.hideWorkspacesFromOtherDevices === true
  const switches: WorkspaceKindSwitches = {
    hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace === true,
    hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
    hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
    hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true
  }
  if (!hideOtherClients && !Object.values(switches).some(Boolean)) {
    return false
  }
  const workspaceId = scope.workspaceId
  if (scope.workspaceKind === 'folder') {
    // Folder rows answer only the other-client switch, as in the sidebar.
    const folder = deps.store.getFolderWorkspaces?.().find((item) => item.id === workspaceId)
    return (
      hideOtherClients && folder !== undefined && isCreatedByAnotherClient(folder.creatorProvenance)
    )
  }
  const lineage = deps.store.getAllWorktreeLineage?.() ?? {}
  if (Object.values(lineage).some((entry) => entry.parentWorktreeId === workspaceId)) {
    return false
  }
  const listed = deps.resolvedWorktrees?.find((worktree) => worktree.id === workspaceId)
  const meta = deps.store.getWorktreeMeta(workspaceId)
  if (!listed && !meta) {
    return false
  }
  if (
    hideOtherClients &&
    isCreatedByAnotherClient(listed?.creatorProvenance ?? meta?.creatorProvenance)
  ) {
    return true
  }
  // Without a Git listing, no branch or HEAD is known, so only the provenance switches can apply.
  const kind = {
    isMainWorktree: listed?.isMainWorktree ?? false,
    branch: listed?.branch ?? '',
    head: listed?.head ?? '',
    ephemeralVmCheckoutMode: listed?.ephemeralVmCheckoutMode,
    automationProvenance: listed?.automationProvenance ?? meta?.automationProvenance,
    cliProvenance: listed?.cliProvenance ?? meta?.cliProvenance
  }
  return isHiddenByWorkspaceKindSwitch(
    kind,
    deps.store.getRepo(getRepoIdFromWorktreeId(workspaceId)),
    switches
  )
}
