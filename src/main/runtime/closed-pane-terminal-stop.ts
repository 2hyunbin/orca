// Which terminals a closed pane may stop: only a process spawned for that pane, or an SSH id.

import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { leafIdsOf } from '../../shared/workspace-layout/workspace-layout-command-steps'
import {
  paneKeyOf,
  type WorkspaceLayoutModel
} from '../../shared/workspace-layout/workspace-layout-model'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** A terminal a close unbound, with the pane that bound it (absent when no pane did). */
export type ClosedPaneTerminal = {
  ptyId: string
  pane?: { worktreeId: string; tabId: string; paneKey: string }
}

/** Each stopped id with the pane that bound it in the model the close was applied to. */
export function closedPaneTerminals(
  model: WorkspaceLayoutModel,
  ptyIds: readonly string[]
): ClosedPaneTerminal[] {
  const panes = new Map<string, NonNullable<ClosedPaneTerminal['pane']>>()
  for (const workspace of Object.values(model.workspaces)) {
    for (const tab of workspace.tabs) {
      for (const leafId of tab.kind === 'terminal' ? leafIdsOf(tab) : []) {
        const ptyId = workspace.leaves?.[leafId]?.ptyId
        if (ptyId && !panes.has(ptyId)) {
          const paneKey = paneKeyOf(tab.entityId, leafId)
          panes.set(ptyId, { worktreeId: workspace.worktreeId, tabId: tab.entityId, paneKey })
        }
      }
    }
  }
  return ptyIds.map((ptyId) => {
    const pane = panes.get(ptyId)
    return pane ? { ptyId, pane } : { ptyId }
  })
}

/** A window-published tab's panes, as the terminals its close unbound. */
export function closedTabTerminals(
  worktreeId: string,
  tabId: string,
  ptyIdsByLeafId: Record<string, string | null | undefined>
): ClosedPaneTerminal[] {
  return Object.entries(ptyIdsByLeafId).flatMap(([leafId, ptyId]) =>
    ptyId ? [{ ptyId, pane: { worktreeId, tabId, paneKey: paneKeyOf(tabId, leafId) } }] : []
  )
}

/**
 * Local ids restart at each launch, so a saved id can name another pane's process: only a live
 * one spawned for this pane is stop authority (main's `mobileTerminalTabMatchesPty`).
 */
export function mayStopClosedPaneTerminal(
  closed: ClosedPaneTerminal,
  pty: Pick<RuntimePtyWorktreeRecord, 'connected' | 'worktreeId' | 'tabId' | 'paneKey'> | undefined
): boolean {
  if (parseAppSshPtyId(closed.ptyId)) {
    return true
  }
  const pane = closed.pane
  return Boolean(
    pty?.connected &&
    pane &&
    pty.worktreeId === pane.worktreeId &&
    pty.tabId === pane.tabId &&
    pty.paneKey === pane.paneKey
  )
}
