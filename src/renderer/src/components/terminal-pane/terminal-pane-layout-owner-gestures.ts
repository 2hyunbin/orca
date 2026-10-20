import type { PaneManager, PaneManagerOptions } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'
import { samePanesIgnoringRatios } from '../../../../shared/workspace-layout/terminal-pane-tree'
import {
  allSplitRatios,
  changedSplitRatios,
  type SplitRatioIntent
} from '../../../../shared/workspace-layout/split-ratio-intents'

/**
 * A layout-owner build's pane gestures: an in-tab drop goes to main, whose frame moves the pane,
 * and not when main refuses; a divider's new ratios, already drawn while dragging, go to main as
 * the dividers that moved when the drag ends.
 */
export function layoutOwnerPaneGestures(pane: {
  worktreeId: string
  tabId: string
  managerRef: { current: PaneManager | null }
  /** False while a restore owns the layout; the drawn ratios are then not the user's. */
  shouldPersistLayout: () => boolean
}): Pick<PaneManagerOptions, 'takePaneDrop' | 'onDividerRatiosCommitted'> {
  const { worktreeId, tabId } = pane
  const saveRatios = (): void => {
    // Why the store: the gesture's own persist has just written the window's tree there.
    const root = useAppStore.getState().terminalLayoutsByTabId[tabId]?.root
    const ratios = root && pane.shouldPersistLayout() ? dividersMoved(worktreeId, tabId, root) : []
    if (ratios.length > 0) {
      const keep = (): void => {}
      sendLayoutCommandToOwner(
        worktreeId,
        { type: 'setPaneRatios', tabId, ratios },
        { apply: keep, asToday: keep }
      )
    }
  }
  return {
    takePaneDrop: ({ sourcePaneId, targetPaneId, zone }, move) => {
      const manager = pane.managerRef.current
      const leafId = manager?.getLeafId(sourcePaneId)
      const targetLeafId = manager?.getLeafId(targetPaneId)
      if (!leafId || !targetLeafId) {
        return false
      }
      return sendLayoutCommandToOwner(
        worktreeId,
        { type: 'movePane', tabId, leafId, targetLeafId, side: zone },
        // A refusal left main's tree, which frames draw, as it was: the window keeps its shape.
        { apply: () => {}, asToday: move, refused: () => {} }
      )
    },
    onDividerRatiosCommitted: saveRatios
  }
}

/** The window's ratios main's tree lacks: each moved divider, or every one before main's frame. */
function dividersMoved(
  worktreeId: string,
  tabId: string,
  root: TerminalPaneLayoutNode
): SplitRatioIntent[] {
  const mainRoot = layoutFrameTerminalTab(worktreeId, tabId)?.terminal?.root
  if (!mainRoot) {
    return allSplitRatios(root)
  }
  // Main's panes moved on since this window drew them; its frame redraws them with their ratios.
  return samePanesIgnoringRatios(mainRoot, root) ? changedSplitRatios(mainRoot, root) : []
}
