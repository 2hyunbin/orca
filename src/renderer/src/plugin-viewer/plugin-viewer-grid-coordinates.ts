import type { PluginViewerViewport } from '../../../shared/plugins/plugin-viewer-surface'

export const VIEWER_ROW_HEIGHT = 28
export const VIEWER_COLUMN_WIDTH = 160
export const VIEWER_ROW_HEADER_WIDTH = 48
export type ViewerGridCoordinate = { row: number; column: number }
export type ViewerTableViewport = Extract<PluginViewerViewport, { kind: 'table' }>

export function viewerColumnName(index: number): string {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name
  }
  return name
}

export function viewerGridNavigation(
  coordinate: ViewerGridCoordinate,
  key: string,
  documentEdge: boolean,
  rowCount: number,
  columnCount: number,
  pageRows: number
): ViewerGridCoordinate | null {
  let { row, column } = coordinate
  if (key === 'ArrowUp') {
    row--
  } else if (key === 'ArrowDown') {
    row++
  } else if (key === 'ArrowLeft') {
    column--
  } else if (key === 'ArrowRight') {
    column++
  } else if (key === 'PageUp') {
    row -= pageRows
  } else if (key === 'PageDown') {
    row += pageRows
  } else if (key === 'Home') {
    column = 0
    if (documentEdge) {
      row = 0
    }
  } else if (key === 'End') {
    column = columnCount - 1
    if (documentEdge) {
      row = rowCount - 1
    }
  } else {
    return null
  }
  return {
    row: Math.max(0, Math.min(Math.max(0, rowCount - 1), row)),
    column: Math.max(0, Math.min(Math.max(0, columnCount - 1), column))
  }
}

export function viewerGridScroll(
  coordinate: ViewerGridCoordinate,
  pane: { top: number; left: number; height: number; width: number }
): { top: number; left: number } {
  return {
    top: Math.max(
      0,
      Math.min(
        coordinate.row * VIEWER_ROW_HEIGHT,
        Math.max(pane.top, (coordinate.row + 2) * VIEWER_ROW_HEIGHT - pane.height)
      )
    ),
    left: Math.max(
      0,
      Math.min(
        coordinate.column * VIEWER_COLUMN_WIDTH,
        Math.max(
          pane.left,
          (coordinate.column + 1) * VIEWER_COLUMN_WIDTH + VIEWER_ROW_HEADER_WIDTH - pane.width
        )
      )
    )
  }
}
