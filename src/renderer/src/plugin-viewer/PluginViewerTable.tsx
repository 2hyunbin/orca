import { useEffect, useRef, useState } from 'react'
import type { PluginViewerChrome } from '../../../shared/plugins/plugin-viewer-frame-protocol'
import type {
  PluginViewerSurface,
  PluginViewerView
} from '../../../shared/plugins/plugin-viewer-surface'
import {
  VIEWER_COLUMN_WIDTH,
  VIEWER_ROW_HEIGHT,
  VIEWER_ROW_HEADER_WIDTH,
  viewerColumnName,
  viewerGridNavigation,
  viewerGridScroll,
  type ViewerGridCoordinate,
  type ViewerTableViewport
} from './plugin-viewer-grid-coordinates'
import { PluginViewerCellInspection, type ViewerInspectedCell } from './PluginViewerCellInspection'
import { copyPluginViewerCellValue } from './plugin-viewer-selection-copy'

export function PluginViewerTable({
  sheet,
  viewport,
  view,
  labels,
  change,
  copySelection
}: {
  sheet: Extract<PluginViewerSurface, { kind: 'table' }>['sheets'][number]
  viewport: ViewerTableViewport
  view: Extract<PluginViewerView, { kind: 'table' }> | null
  labels: PluginViewerChrome['labels']
  change(viewport: ViewerTableViewport): void
  copySelection(): Promise<boolean>
}): React.JSX.Element {
  const scroll = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLTableElement>(null)
  const [selection, setSelection] = useState<ViewerGridCoordinate>({
    row: viewport.startRow,
    column: viewport.startColumn
  })
  const [inspection, setInspection] = useState<ViewerInspectedCell | null>(null)
  useEffect(() => {
    const element = scroll.current
    if (!element) {
      return
    }
    const resize = (): void => {
      const rowCount = Math.max(
        1,
        Math.min(64, Math.ceil((element.clientHeight - VIEWER_ROW_HEIGHT) / VIEWER_ROW_HEIGHT) + 1)
      )
      const columnCount = Math.max(
        1,
        Math.min(
          64,
          Math.ceil((element.clientWidth - VIEWER_ROW_HEADER_WIDTH) / VIEWER_COLUMN_WIDTH) + 1
        )
      )
      if (rowCount !== viewport.rowCount || columnCount !== viewport.columnCount) {
        change({ ...viewport, rowCount, columnCount })
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [viewport, change])
  useEffect(() => {
    const element = scroll.current
    if (!element) {
      return
    }
    if (Math.floor(element.scrollTop / VIEWER_ROW_HEIGHT) !== viewport.startRow) {
      element.scrollTop = viewport.startRow * VIEWER_ROW_HEIGHT
    }
    if (Math.floor(element.scrollLeft / VIEWER_COLUMN_WIDTH) !== viewport.startColumn) {
      element.scrollLeft = viewport.startColumn * VIEWER_COLUMN_WIDTH
    }
  }, [viewport])
  const rows = Array.from(
    { length: Math.min(viewport.rowCount, sheet.rowCount - viewport.startRow) },
    (_, offset) => viewport.startRow + offset
  )
  const columns = Array.from(
    { length: Math.min(viewport.columnCount, sheet.columnCount - viewport.startColumn) },
    (_, offset) => viewport.startColumn + offset
  )
  const selected = {
    row: Math.max(viewport.startRow, Math.min(selection.row, rows.at(-1) ?? 0)),
    column: Math.max(viewport.startColumn, Math.min(selection.column, columns.at(-1) ?? 0))
  }
  const cells = new Map(view?.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]) ?? [])
  const cell = cells.get(`${selected.row}:${selected.column}`)
  const selectedName = `${viewerColumnName(selected.column)}${selected.row + 1}`
  const ready = !!view && rows.length > 0 && columns.length > 0
  const inspect = (open: boolean): void => {
    setInspection(
      open && ready
        ? { name: selectedName, text: cell?.text ?? '', cached: cell?.kind === 'cached-formula' }
        : null
    )
  }
  return (
    <>
      <div
        ref={scroll}
        className="scrollbar-editor relative min-h-0 flex-1 overflow-auto"
        data-viewer-scroll
        onScroll={(event) => {
          const startRow = Math.min(
            Math.max(0, sheet.rowCount - 1),
            Math.floor(event.currentTarget.scrollTop / VIEWER_ROW_HEIGHT)
          )
          const startColumn = Math.min(
            Math.max(0, sheet.columnCount - 1),
            Math.floor(event.currentTarget.scrollLeft / VIEWER_COLUMN_WIDTH)
          )
          if (startRow !== viewport.startRow || startColumn !== viewport.startColumn) {
            change({ ...viewport, startRow, startColumn })
          }
        }}
      >
        {sheet.rowCount === 0 || sheet.columnCount === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <div
            className="relative"
            style={{
              height: (sheet.rowCount + 1) * VIEWER_ROW_HEIGHT,
              width: sheet.columnCount * VIEWER_COLUMN_WIDTH + VIEWER_ROW_HEADER_WIDTH
            }}
          >
            <table
              ref={grid}
              role="grid"
              tabIndex={0}
              aria-label={`${labels.sheet}: ${sheet.label}`}
              aria-readonly
              aria-rowcount={sheet.rowCount + 1}
              aria-colcount={sheet.columnCount + 1}
              aria-activedescendant={`viewer-cell-${selected.row}-${selected.column}`}
              className="absolute table-fixed border-collapse text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                top: viewport.startRow * VIEWER_ROW_HEIGHT,
                left: viewport.startColumn * VIEWER_COLUMN_WIDTH,
                width: columns.length * VIEWER_COLUMN_WIDTH + VIEWER_ROW_HEADER_WIDTH
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  inspect(true)
                  return
                }
                if (event.altKey) {
                  return
                }
                const documentEdge = navigator.userAgent.includes('Mac')
                  ? event.metaKey
                  : event.ctrlKey
                if (documentEdge && event.key.toLowerCase() === 'c') {
                  event.preventDefault()
                  if (ready) {
                    void copyPluginViewerCellValue(cell?.text ?? '', copySelection, labels)
                  }
                  return
                }
                const element = scroll.current
                if (!element) {
                  return
                }
                const target = viewerGridNavigation(
                  selected,
                  event.key,
                  documentEdge,
                  sheet.rowCount,
                  sheet.columnCount,
                  Math.max(
                    1,
                    Math.floor((element.clientHeight - VIEWER_ROW_HEIGHT) / VIEWER_ROW_HEIGHT)
                  )
                )
                if (!target) {
                  return
                }
                event.preventDefault()
                setSelection(target)
                const position = viewerGridScroll(target, {
                  top: element.scrollTop,
                  left: element.scrollLeft,
                  height: element.clientHeight,
                  width: element.clientWidth
                })
                element.scrollTop = position.top
                element.scrollLeft = position.left
                const next = {
                  ...viewport,
                  startRow: Math.floor(element.scrollTop / VIEWER_ROW_HEIGHT),
                  startColumn: Math.floor(element.scrollLeft / VIEWER_COLUMN_WIDTH)
                }
                if (
                  next.startRow !== viewport.startRow ||
                  next.startColumn !== viewport.startColumn
                ) {
                  change(next)
                }
              }}
            >
              <thead>
                <tr role="row" aria-rowindex={1}>
                  <th
                    role="columnheader"
                    aria-colindex={1}
                    className="sticky top-0 left-0 z-20 border border-border bg-muted text-muted-foreground"
                    style={{ width: VIEWER_ROW_HEADER_WIDTH, height: VIEWER_ROW_HEIGHT }}
                  />
                  {columns.map((column) => (
                    <th
                      key={column}
                      role="columnheader"
                      aria-colindex={column + 2}
                      scope="col"
                      className="sticky top-0 z-10 border border-border bg-muted font-medium text-muted-foreground"
                      style={{ minWidth: VIEWER_COLUMN_WIDTH, height: VIEWER_ROW_HEIGHT }}
                    >
                      {viewerColumnName(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row} role="row" aria-rowindex={row + 2}>
                    <th
                      role="rowheader"
                      aria-colindex={1}
                      scope="row"
                      className="sticky left-0 z-10 border border-border bg-muted font-normal text-muted-foreground"
                      style={{ height: VIEWER_ROW_HEIGHT }}
                    >
                      {row + 1}
                    </th>
                    {columns.map((column) => {
                      const entry = cells.get(`${row}:${column}`)
                      const active = selected.row === row && selected.column === column
                      return (
                        <td
                          key={column}
                          id={`viewer-cell-${row}-${column}`}
                          role="gridcell"
                          aria-colindex={column + 2}
                          aria-selected={active}
                          title={
                            entry?.kind === 'cached-formula'
                              ? `${labels.cachedFormula}\n${entry.text}`
                              : entry?.text
                          }
                          className={`max-w-40 truncate border border-border px-3 text-foreground ${active ? 'bg-accent ring-1 ring-inset ring-ring' : ''}`}
                          style={{ height: VIEWER_ROW_HEIGHT }}
                          onClick={() => {
                            setSelection({ row, column })
                            grid.current?.focus({ preventScroll: true })
                          }}
                          onDoubleClick={() => {
                            if (view) {
                              setSelection({ row, column })
                              setInspection({
                                name: `${viewerColumnName(column)}${row + 1}`,
                                text: entry?.text ?? '',
                                cached: entry?.kind === 'cached-formula'
                              })
                            }
                          }}
                        >
                          {entry?.text ?? ''}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border px-3">
        <span className="min-w-12 text-xs text-muted-foreground">{ready ? selectedName : '—'}</span>
        <PluginViewerCellInspection
          cell={
            inspection ?? {
              name: selectedName,
              text: cell?.text ?? '',
              cached: cell?.kind === 'cached-formula'
            }
          }
          open={inspection !== null}
          ready={ready}
          labels={labels}
          setOpen={inspect}
          restoreFocus={() => grid.current?.focus({ preventScroll: true })}
          copySelection={copySelection}
        />
      </div>
    </>
  )
}
