import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import { isSameTerminal } from '../../shared/workspace-layout/terminal-owner-invariants'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'

/** `legacy`: the row has no tab-bar entry, so the Loader matches its terminals by id alone. */
type TerminalBinding = { ptyId: string; incarnationId?: string; legacy: boolean }

/**
 * Whether stored rows repeat a row id, or bind one terminal (as the Loader compares terminals) in
 * two rows or two of a row's mounted panes. Exists only to skip the Loader's cost.
 */
function storedTerminalsRepeat(session: WorkspaceSessionState): boolean {
  const rowIds = new Set<string>()
  const boundByPtyId = new Map<string, TerminalBinding[]>()
  for (const [key, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    const tabBarIds = new Set(
      (session.unifiedTabs?.[key] ?? [])
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => tab.entityId)
    )
    for (const row of rows) {
      const legacy = !tabBarIds.has(row.id)
      const layout = session.terminalLayoutsByTabId?.[row.id]
      const paneIds = layout?.root
        ? collectLayoutLeafIdsInOrder(layout.root)
        : Object.keys(layout?.ptyIdsByLeafId ?? {})
      const panes = paneIds.flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId]
        const incarnationId = session.terminalPtyIncarnationsByPaneKey?.[`${row.id}:${leafId}`]
        return ptyId ? [{ ptyId, incarnationId, legacy }] : []
      })
      const bindings = [
        ...panes,
        ...(row.ptyId && !panes.some((pane) => pane.ptyId === row.ptyId)
          ? [{ ptyId: row.ptyId, legacy }]
          : [])
      ]
      // Two tab-bar rows are compared by incarnation, as the Loader's pane check does.
      const repeats = (binding: TerminalBinding, others: readonly TerminalBinding[]) =>
        others.some(
          (other) =>
            other.ptyId === binding.ptyId &&
            (other.legacy || binding.legacy || isSameTerminal(other, binding))
        )
      if (
        rowIds.has(row.id) ||
        panes.some((pane, index) => repeats(pane, panes.slice(0, index))) ||
        bindings.some((binding) => repeats(binding, boundByPtyId.get(binding.ptyId) ?? []))
      ) {
        return true
      }
      rowIds.add(row.id)
      for (const binding of bindings) {
        boundByPtyId.set(binding.ptyId, [...(boundByPtyId.get(binding.ptyId) ?? []), binding])
      }
    }
  }
  return false
}

/**
 * The partition the phone is built from: the stored rows unchanged, or for a partition that
 * repeats a row or terminal, the shared Loader's result whole, as the window shows it. `cache`
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
