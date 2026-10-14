// Whether this host's own phone push for a structured-chat edge must stay quiet because the
// desktop's sidebar Filters hide the workspace and "Notify about hidden workspaces" is off.
//
// WHY ONLY THE KIND SWITCHES: main sees the persisted switches and its in-memory workspace records,
// not the renderer's live tabs or paired-device map, so "Hide sleeping" and "Hide other-client" are
// left to the renderer. A local chat that raises attention is live, so it is not sleeping anyway.
//
// FAILS OPEN: no persisted UI, no record of the workspace, or a workspace with a lineage child (the
// sidebar shows a hidden parent above a visible child) all notify.
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import {
  isHiddenByWorkspaceKindSwitch,
  type WorkspaceKindSwitches
} from '../../shared/worktree/workspace-kinds'
import type { RuntimeStore } from './runtime-store-contract'

export type HiddenWorkspaceAttentionDeps = {
  store: Pick<RuntimeStore, 'getUI' | 'getRepo' | 'getWorktreeMeta' | 'getAllWorktreeLineage'>
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
  if (scope.workspaceKind === 'folder') {
    return false
  }
  const ui = deps.store.getUI?.()
  if (!ui) {
    return false
  }
  const switches: WorkspaceKindSwitches = {
    hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace === true,
    hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
    hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
    hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true
  }
  if (!Object.values(switches).some(Boolean)) {
    return false
  }
  const workspaceId = scope.workspaceId
  const lineage = deps.store.getAllWorktreeLineage?.() ?? {}
  if (Object.values(lineage).some((entry) => entry.parentWorktreeId === workspaceId)) {
    return false
  }
  const listed = deps.resolvedWorktrees?.find((worktree) => worktree.id === workspaceId)
  const meta = deps.store.getWorktreeMeta(workspaceId)
  if (!listed && !meta) {
    return false
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
