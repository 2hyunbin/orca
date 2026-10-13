import type { TabGroupLayoutNode } from '../../shared/tab-types'

type GridSize = { cols: number; rows: number }

// Why 120x40: no window measured the group the tab opens in: none attached (serve, orcad), or no
// pane at the default font mounted yet. #1707's original size.
export const UNMEASURED_GRID_SIZE: GridSize = { cols: 120, rows: 40 }

/** Grid for a tab opening in a workspace the window has not shown, so none of its groups is measured.
 *  Splits divide the single-group grid by the group count along the root split, without ratios or
 *  per-group chrome, so a split can still start slightly wide; the cap keeps it no wider than
 *  UNMEASURED_GRID_SIZE. */
export function unshownWorkspaceGridSize(
  singleGroupGrid: GridSize | undefined,
  groupCount: number,
  rootLayout: TabGroupLayoutNode | undefined
): GridSize | undefined {
  if (!singleGroupGrid || groupCount <= 1) {
    return singleGroupGrid
  }
  if (rootLayout?.type !== 'split') {
    return undefined
  }
  const sideBySide = rootLayout.direction === 'horizontal'
  return {
    cols: Math.min(
      UNMEASURED_GRID_SIZE.cols,
      sideBySide ? Math.floor(singleGroupGrid.cols / groupCount) : singleGroupGrid.cols
    ),
    rows: Math.min(
      UNMEASURED_GRID_SIZE.rows,
      sideBySide ? singleGroupGrid.rows : Math.floor(singleGroupGrid.rows / groupCount)
    )
  }
}
