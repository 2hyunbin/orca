// Layout-owner builds: main's close drops the pane before its terminal exits, so the exit finds
// the pane in main's closed-pane record, by the terminal's id and incarnation both (L80 Q2). The
// exit that used the entry removes it.
import { closedTerminalPaneOf } from '../../../../shared/closed-terminal-panes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

export function takeClosedPaneOfExitedPty(
  store: RuntimeStore | null | undefined,
  hostId: ExecutionHostId | null,
  pty: { ptyId: string; worktreeId: string },
  incarnationId: string | null | undefined
): { tabId: string; paneKey: string } | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !incarnationId || !store?.getWorkspaceSession) {
    return null
  }
  const session = store.getWorkspaceSession(hostId ?? undefined)
  const pane = closedTerminalPaneOf(session?.closedTerminalPanesByPaneKey, pty.ptyId, incarnationId)
  const separator = pane?.paneKey.lastIndexOf(':') ?? -1
  if (!session || !pane || separator < 1 || !worktreeIdsEqual(pane.worktreeId, pty.worktreeId)) {
    return null
  }
  const remaining = { ...session.closedTerminalPanesByPaneKey }
  delete remaining[pane.paneKey]
  store.setWorkspaceSession?.(
    { ...session, closedTerminalPanesByPaneKey: remaining },
    hostId ?? undefined
  )
  return { tabId: pane.paneKey.slice(0, separator), paneKey: pane.paneKey }
}
