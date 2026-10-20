// A split pane whose terminal ended, in a workspace main owns (layout-owner build): main closes it
// through the layout model, or keeps it, by the rule the window used to apply to its own panes.
import type { ExecutionHostId } from '../../shared/execution-host'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import {
  exitedSplitPaneOutcome,
  type ExitedSplitPaneFacts
} from './terminal/lifecycle/exited-split-pane-rule'

/**
 * The session with the pane closed, the same session when the rule keeps it, or null when the
 * surface is not a split pane bound to this terminal: a tab's last pane, or a pane another
 * terminal took since. Null leaves the exit to the persistence retirement.
 */
export function closeExitedSplitPaneInSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface,
  facts: ExitedSplitPaneFacts
): WorkspaceSessionState | null {
  const layout = session.terminalLayoutsByTabId?.[surface.parentTabId]
  const leafIds = collectLeafIds(layout?.root)
  const paneKey = `${surface.parentTabId}:${surface.leafId}`
  const boundIncarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  if (
    leafIds.length < 2 ||
    !leafIds.includes(surface.leafId) ||
    layout?.ptyIdsByLeafId?.[surface.leafId] !== surface.ptyId ||
    (surface.incarnationId && boundIncarnationId && boundIncarnationId !== surface.incarnationId)
  ) {
    return null
  }
  if (exitedSplitPaneOutcome(facts) === 'keep') {
    return session
  }
  return (
    applyCommandToSession(hostId, session, {
      type: 'closePane',
      workspace: surface.worktreeId,
      tabId: surface.parentTabId,
      leafId: surface.leafId
    }).session ?? session
  )
}
