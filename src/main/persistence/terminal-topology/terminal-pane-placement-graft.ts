import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  insertLeafBeside,
  layoutContainsLeafId,
  removeLayoutLeaf,
  samePanesIgnoringRatios
} from '../../../shared/workspace-layout/terminal-pane-tree'
import { cloneLayoutNode } from '../restoring-sessions/terminal-layout-normalization'

/**
 * Where a split's new pane joins a tree that lacks it: the window's tree when it is this tree plus
 * only that pane (the one way to say "before" or split a group of panes), else beside the parent
 * pane. Null when the spawn names no split or a parent this tree does not hold.
 */
export function placedSplitRoot(
  root: TerminalPaneLayoutNode,
  leafId: string,
  placement: TerminalPanePlacement | undefined
): TerminalPaneLayoutNode | null {
  if (placement?.kind !== 'split' || !layoutContainsLeafId(root, placement.parentLeafId)) {
    return null
  }
  const { proposedRoot, parentLeafId, direction, ratio } = placement
  if (proposedRoot && addsOnlyLeaf(root, proposedRoot, leafId)) {
    return cloneLayoutNode(proposedRoot)
  }
  return insertLeafBeside(
    cloneLayoutNode(root),
    parentLeafId,
    leafId,
    direction === 'vertical' ? 'right' : 'bottom',
    ratio
  )
}

function addsOnlyLeaf(
  root: TerminalPaneLayoutNode,
  proposed: TerminalPaneLayoutNode,
  leafId: string
): boolean {
  const without = removeLayoutLeaf(proposed, leafId)
  return (
    collectLayoutLeafIdsInOrder(proposed).filter((id) => id === leafId).length === 1 &&
    without !== null &&
    samePanesIgnoringRatios(without, root)
  )
}
