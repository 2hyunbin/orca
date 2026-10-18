// Where a window's save differs from main in ways main's layout model cannot show, read from the
// sessions themselves: the Loader rebuilds a dropped terminal tab-bar entry from its row, and
// places closed-tab records into whatever workspace a key names. Each finding is added to `paths`
// under its workspace.

import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** The terminal tabs (by entity id) each workspace's stored tab bar names. */
export function terminalTabBarEntries(session: WorkspaceSessionState): Map<string, Set<string>> {
  return new Map(
    Object.entries(session.unifiedTabs ?? {}).map(([workspace, entries]) => [
      workspace,
      new Set(
        entries.flatMap((entry) => (entry.contentType === 'terminal' ? [entry.entityId] : []))
      )
    ])
  )
}

function addPath(paths: Map<string, string[]>, workspace: string, path: string): void {
  paths.set(workspace, [...(paths.get(workspace) ?? []), path])
}

/**
 * A tab-bar entry the save dropped from a tab bar it still writes, while the row stays: the Loader
 * rebuilds that entry from the row, so main's model shows no change.
 */
export function droppedTabBarEntries(
  wasEntries: ReadonlyMap<string, ReadonlySet<string>>,
  now: WorkspaceSessionState | null | undefined,
  paths: Map<string, string[]>
): void {
  const nowEntries = now ? terminalTabBarEntries(now) : new Map<string, Set<string>>()
  for (const [workspace, entities] of wasEntries) {
    const kept = nowEntries.get(workspace)
    // No tab bar at all: a save that predates main's first frame for the workspace.
    if (!kept) {
      continue
    }
    const rows = new Set((now?.tabsByWorktree?.[workspace] ?? []).map((row) => row.id))
    for (const entityId of entities) {
      if (!kept.has(entityId) && rows.has(entityId)) {
        addPath(paths, workspace, `terminal ${entityId} tab-bar entry removed`)
      }
    }
  }
}

type PartitionCopy = {
  model: WorkspaceLayoutModel | null
  closed: WorkspaceSessionState['closedTerminalTabTombstonesByTabId']
}

/**
 * Closed-tab records of a workspace only one copy has: the model diff cannot tell a record the
 * Loader just placed there (already stored, unplaced) from one the save added or dropped.
 */
export function closedTabsOfOneSidedWorkspaces(
  was: PartitionCopy,
  now: PartitionCopy,
  paths: Map<string, string[]>
): void {
  const oneSided = (from: PartitionCopy, other: PartitionCopy, change: string) => {
    for (const [workspace, layout] of Object.entries(from.model?.workspaces ?? {})) {
      if (other.model?.workspaces[workspace]) {
        continue
      }
      for (const tabId of Object.keys(layout.closedTerminalTabs ?? {})) {
        if (other.closed?.[tabId]?.worktreeId !== layout.worktreeId) {
          addPath(paths, workspace, `closed tab ${tabId} ${change}`)
        }
      }
    }
  }
  oneSided(now, was, 'added')
  oneSided(was, now, 'removed')
}
