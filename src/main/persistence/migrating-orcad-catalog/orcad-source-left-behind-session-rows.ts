import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/**
 * Saved rows the managed server cannot hold and that are no one's live work, removed from a copy
 * of one partition before export. The profile itself keeps them, so a downgrade still has them.
 */
export function withoutLeftBehindSessionRows(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const owns = (ownerKey: string): boolean => orcadMigrationOwnerMatchesScope(ownerKey, scope)
  const isolated = new Set(
    Object.entries(session.browserTabsByWorktree ?? {}).flatMap(([ownerKey, workspaces]) =>
      owns(ownerKey) ? workspaces.filter(usesSessionProfile).map((workspace) => workspace.id) : []
    )
  )
  const hiddenFiles = hiddenHostBoundFiles(session, owns)
  if (isolated.size === 0 && hiddenFiles.size === 0) {
    return session
  }
  const next = structuredClone(session)
  if (isolated.size > 0) {
    dropBrowserWorkspaces(next, isolated)
  }
  for (const [ownerKey, filePaths] of hiddenFiles) {
    next.openFilesByWorktree![ownerKey] = next.openFilesByWorktree![ownerKey].filter(
      (file) => !filePaths.has(file.filePath)
    )
    const active = next.activeFileIdByWorktree?.[ownerKey]
    if (active && filePaths.has(active)) {
      delete next.activeFileIdByWorktree![ownerKey]
    }
  }
  return next
}

/** Whether a partition is some Orca profile's shared browser default rather than a session profile. */
export function isOrcaProfileBrowserDefaultPartition(partition: string): boolean {
  return (
    partition === ORCA_BROWSER_PARTITION ||
    (partition.startsWith('persist:orca-profile-') &&
      partition.endsWith('-browser-default') &&
      !partition.includes('-browser-session-'))
  )
}

/** A tab switched back to Default keeps the default partition, which carries over as it is. */
function usesSessionProfile(workspace: BrowserWorkspace): boolean {
  const { sessionProfileId, sessionPartition } = workspace
  return (
    (sessionProfileId ? sessionProfileId !== 'default' : false) ||
    (sessionPartition ? !isOrcaProfileBrowserDefaultPartition(sessionPartition) : false)
  )
}

/**
 * Isolated-profile browser tabs. Their profile is this desktop's alone and the server stores none,
 * so carrying the tab would reopen it in the shared profile; leaving it keeps the isolation.
 */
function dropBrowserWorkspaces(session: WorkspaceSessionState, workspaceIds: Set<string>): void {
  for (const [ownerKey, workspaces] of Object.entries(session.browserTabsByWorktree ?? {})) {
    session.browserTabsByWorktree![ownerKey] = workspaces.filter(
      (workspace) => !workspaceIds.has(workspace.id)
    )
    if (workspaceIds.has(session.activeBrowserTabIdByWorktree?.[ownerKey] ?? '')) {
      delete session.activeBrowserTabIdByWorktree![ownerKey]
    }
  }
  for (const workspaceId of workspaceIds) {
    delete session.browserPagesByWorkspace?.[workspaceId]
  }
  const droppedTabIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    session.unifiedTabs![ownerKey] = tabs.filter((tab) => {
      const dropped = tab.contentType === 'browser' && workspaceIds.has(tab.entityId)
      if (dropped) {
        droppedTabIds.add(tab.id)
      }
      return !dropped
    })
  }
  for (const groups of Object.values(session.tabGroups ?? {})) {
    for (const group of groups) {
      group.tabOrder = group.tabOrder.filter((id) => !droppedTabIds.has(id))
      group.recentTabIds = group.recentTabIds?.filter((id) => !droppedTabIds.has(id))
      if (group.activeTabId && droppedTabIds.has(group.activeTabId)) {
        group.activeTabId = group.recentTabIds?.at(-1) ?? group.tabOrder[0] ?? null
      }
    }
  }
}

/**
 * Clean editor files bound to another host that no tab shows. The user cannot see or close them,
 * and the server cannot hold them; one with an unsaved draft is never in this set.
 */
function hiddenHostBoundFiles(
  session: WorkspaceSessionState,
  owns: (ownerKey: string) => boolean
): Map<string, Set<string>> {
  const hidden = new Map<string, Set<string>>()
  // Without the unified model, hydration shows every saved file as a tab.
  if (!session.unifiedTabs || !session.tabGroups) {
    return hidden
  }
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!owns(ownerKey)) {
      continue
    }
    const shown = new Set(
      (session.unifiedTabs[ownerKey] ?? []).flatMap((tab) => [tab.id, tab.entityId])
    )
    for (const file of files) {
      const hostBound = file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
      const visible =
        shown.has(file.filePath) ||
        shown.has(ownedEditorFileId(file.filePath, ownerKey, file.runtimeEnvironmentId))
      if (hostBound && file.dirtyDraftContent === undefined && !visible) {
        hidden.set(ownerKey, (hidden.get(ownerKey) ?? new Set()).add(file.filePath))
      }
    }
  }
  return hidden
}
