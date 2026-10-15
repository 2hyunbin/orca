import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'

/**
 * Whether stored rows repeat a row id or bind one terminal in two mounted panes. Exists only to
 * skip the Loader's cost: a partition without either is built from its raw rows, as before.
 */
function storedTerminalsRepeat(session: WorkspaceSessionState): boolean {
  const rowIds = new Set<string>()
  const bound = new Set<string>()
  for (const row of Object.values(session.tabsByWorktree ?? {}).flat()) {
    const layout = session.terminalLayoutsByTabId?.[row.id]
    const paneIds = layout?.root
      ? collectLayoutLeafIdsInOrder(layout.root)
      : Object.keys(layout?.ptyIdsByLeafId ?? {})
    const panePtyIds = paneIds.flatMap((leafId) => layout?.ptyIdsByLeafId?.[leafId] ?? [])
    const ptyIds = new Set([...panePtyIds, ...(row.ptyId ? [row.ptyId] : [])])
    if (
      rowIds.has(row.id) ||
      new Set(panePtyIds).size !== panePtyIds.length ||
      [...ptyIds].some((ptyId) => bound.has(ptyId))
    ) {
      return true
    }
    rowIds.add(row.id)
    ptyIds.forEach((ptyId) => bound.add(ptyId))
  }
  return false
}

/**
 * A partition that repeats a row or terminal, as the shared Loader resolves it: which rows are
 * tabs, and which pane shows a terminal another already holds, as the window shows it. `cache`
 * lives for one caller loop. It ignores `hostId`, which only stamps tab-bar entries and never
 * changes which rows or panes survive.
 */
export function loadTerminalSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  cache?: Map<WorkspaceSessionState, WorkspaceSessionState>
): WorkspaceSessionState {
  const loaded =
    cache?.get(session) ??
    (storedTerminalsRepeat(session)
      ? saveWorkspaceLayout(
          loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
        )
      : session)
  cache?.set(session, loaded)
  return loaded
}

export function buildHeadlessMobileSessionTerminalTabs(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): RuntimeMobileSessionTerminalTab[] {
  return [...persistedTabs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .flatMap((tab, index) => {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const leafIds = collectPersistedTerminalLeafIds(layout)
      if (leafIds.length === 0) {
        leafIds.push(deriveHeadlessLegacyTerminalLeafId(tab.id))
      }
      return leafIds.flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
        const title =
          tab.customTitle?.trim() ||
          tab.generatedTitle?.trim() ||
          tab.title?.trim() ||
          tab.defaultTitle?.trim() ||
          `Terminal ${index + 1}`
        return [
          {
            type: 'terminal' as const,
            id: `${tab.id}::${leafId}`,
            parentTabId: tab.id,
            leafId,
            title,
            ...(ptyId ? { ptyId } : {}),
            ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
            ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {}),
            ...(layout ? { parentLayout: cloneTerminalLayoutSnapshot(layout) } : {}),
            ...(tab.color != null ? { color: tab.color } : {}),
            ...(tab.isPinned ? { isPinned: true } : {}),
            ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
            isActive: isPersistedTerminalLeafActive(session, worktreeId, tab.id, leafId, layout)
          }
        ]
      })
    })
}
