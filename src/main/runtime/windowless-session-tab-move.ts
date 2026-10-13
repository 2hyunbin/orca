import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeMobileSessionTabMove } from '../../shared/runtime-types'
import {
  resolveSessionTabRow,
  translateSessionTabMove,
  type ProjectedSessionTabs
} from '../../shared/workspace-layout/old-client'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * The partition after a client's `session.tabs.move`, checked against the list it was shown, as a
 * window applies the same drag: the moved tab shows where it lands, and a group it left that was
 * showing it shows its first tab. Throws the move's refusal code.
 */
export function withMovedSessionTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  shown: ProjectedSessionTabs,
  move: RuntimeMobileSessionTabMove
): WorkspaceSessionState {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[worktreeId]
  if (!workspace) {
    throw new Error('tab_not_found')
  }
  const translation = translateSessionTabMove(worktreeId, workspace, shown, {
    ...move,
    worktree: worktreeId
  })
  if (!translation.ok) {
    throw new Error(translation.code)
  }
  const movedTabId = resolveSessionTabRow(workspace, move.tabId)!.tab.id
  const from = workspace.groups.find((group) => group.tabOrder.includes(movedTabId))
  // A window ignores a split of a group's only tab off that group.
  if (move.kind === 'split' && from?.id === move.targetGroupId && from.tabOrder.length === 1) {
    return session
  }
  const context = { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }
  let model = loaded.layout
  for (const command of translation.commands) {
    const applied = applyLayoutCommand(model, command, context)
    if (!applied.ok) {
      throw new Error(applied.code)
    }
    model = applied.model
  }
  const orders = (layout: typeof model) =>
    JSON.stringify(layout.workspaces[worktreeId]?.groups.map(({ id, tabOrder }) => [id, tabOrder]))
  // A drop that changes no order (onto its own place) changes nothing, selection included.
  if (orders(model) === orders(loaded.layout)) {
    return session
  }
  const landed = model.workspaces[worktreeId]?.groups.find((group) =>
    group.tabOrder.includes(movedTabId)
  )
  const groups = loaded.desktopView.groups[worktreeId] ?? {}
  const nextGroups: typeof groups = {}
  for (const group of model.workspaces[worktreeId]?.groups ?? []) {
    const shownTab = groups[group.id]?.activeTabId
    nextGroups[group.id] = {
      ...groups[group.id],
      activeTabId: group.tabOrder.includes(movedTabId)
        ? movedTabId
        : shownTab && group.tabOrder.includes(shownTab)
          ? shownTab
          : (group.tabOrder[0] ?? null)
    }
  }
  return saveWorkspaceLayout({
    ...loaded,
    layout: model,
    desktopView: {
      ...loaded.desktopView,
      groups: { ...loaded.desktopView.groups, [worktreeId]: nextGroups },
      ...(landed
        ? {
            activeGroupIdByWorktree: {
              ...loaded.desktopView.activeGroupIdByWorktree,
              [worktreeId]: landed.id
            }
          }
        : {})
    }
  })
}
