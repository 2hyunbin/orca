// What a window's save changes that main's layout model cannot show, read from the stored session
// itself: the Loader rebuilds a dropped terminal tab-bar entry from its row, and main keeps its own
// pane trees over the save's. Each finding is added to `paths` under its workspace.

import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type SavedPaneTrees = Readonly<Record<string, TerminalLayoutSnapshot>>

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

/** The save's pane trees that differ from main's for tabs main holds: main keeps its own. */
export function overriddenPaneTrees(
  stored: WorkspaceSessionState | null | undefined,
  model: WorkspaceLayoutModel | null,
  saved: SavedPaneTrees,
  paths: Map<string, string[]>
): void {
  for (const [workspace, layout] of Object.entries(model?.workspaces ?? {})) {
    for (const tab of layout.tabs) {
      const mains = stored?.terminalLayoutsByTabId?.[tab.entityId]?.root
      const windows = saved[tab.entityId]?.root
      if (
        tab.kind === 'terminal' &&
        mains &&
        windows &&
        stableJson(mains) !== stableJson(windows)
      ) {
        addPath(paths, workspace, `pane tree ${tab.entityId} kept over the save’s`)
      }
    }
  }
}
