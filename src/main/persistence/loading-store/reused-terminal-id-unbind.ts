// Layout-owner builds: a local terminal id is a counter, so after a restart a new terminal can reuse
// the id a saved pane still binds. The spawn commit that binds the new terminal also unbinds the id
// from every other pane stamped with a different incarnation, so main's layout names one pane.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type ReusedTerminalBinding = {
  ptyId: string
  incarnationId: string
  tabId: string
  leafId: string
}

/**
 * Drops `ptyId` from each other pane whose stamped incarnation differs, in place, with the stamp.
 * An unstamped binding (a legacy save) is left alone: nothing proves it names another process.
 */
export function unbindReusedTerminalId(
  session: WorkspaceSessionState,
  binding: ReusedTerminalBinding
): void {
  const stamps = session.terminalPtyIncarnationsByPaneKey ?? {}
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const stale = Object.entries(layout.ptyIdsByLeafId ?? {}).flatMap(([leafId, ptyId]) => {
      const stamp = stamps[`${tabId}:${leafId}`]
      const isBindingPane = tabId === binding.tabId && leafId === binding.leafId
      return ptyId === binding.ptyId &&
        !isBindingPane &&
        stamp !== undefined &&
        stamp !== binding.incarnationId
        ? [leafId]
        : []
    })
    if (stale.length === 0) {
      continue
    }
    const stillBound = Object.fromEntries(
      Object.entries(layout.ptyIdsByLeafId ?? {}).filter(([leafId]) => !stale.includes(leafId))
    )
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [tabId]: { ...layout, ptyIdsByLeafId: stillBound }
    }
    session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
        ([paneKey]) => !stale.some((leafId) => paneKey === `${tabId}:${leafId}`)
      )
    )
    // The tab row's own terminal id names the stale process too; it takes a pane still bound.
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
      if (tabs.some((tab) => tab.id === tabId && tab.ptyId === binding.ptyId)) {
        session.tabsByWorktree = {
          ...session.tabsByWorktree,
          [worktreeId]: tabs.map((tab) =>
            tab.id === tabId && tab.ptyId === binding.ptyId
              ? { ...tab, ptyId: Object.values(stillBound)[0] ?? null }
              : tab
          )
        }
      }
    }
  }
}
