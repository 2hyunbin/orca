import { useEffect, useRef } from 'react'
import type {
  PluginViewerSurface,
  PluginViewerView,
  PluginViewerViewport
} from '../../../shared/plugins/plugin-viewer-surface'
import type { PluginViewerChrome } from '../../../shared/plugins/plugin-viewer-frame-protocol'
import { PluginViewerCanvas } from './PluginViewerCanvas'
import { PluginViewerTable } from './PluginViewerTable'
import { VIEWER_ROW_HEIGHT } from './plugin-viewer-grid-coordinates'

export function PluginViewerSurfaceContent({
  surface,
  viewport,
  view,
  labels,
  change,
  copySelection
}: {
  surface: PluginViewerSurface
  viewport: PluginViewerViewport
  view: PluginViewerView | null
  labels: PluginViewerChrome['labels']
  change(viewport: PluginViewerViewport): void
  copySelection(): Promise<boolean>
}): React.JSX.Element {
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scroll.current
    if (
      element &&
      viewport.kind === 'text' &&
      Math.floor(element.scrollTop / VIEWER_ROW_HEIGHT) !== viewport.startLine
    ) {
      element.scrollTop = viewport.startLine * VIEWER_ROW_HEIGHT
    }
  }, [viewport])
  if (viewport.kind === 'canvas') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <PluginViewerCanvas
          viewport={viewport}
          change={change}
          view={view?.kind === 'canvas' ? view : null}
          label={labels.title}
        />
      </div>
    )
  }
  if (viewport.kind === 'table' && surface.kind === 'table') {
    const sheet = surface.sheets.find((candidate) => candidate.id === viewport.sheetId)
    return sheet ? (
      <PluginViewerTable
        key={sheet.id}
        sheet={sheet}
        viewport={viewport}
        change={change}
        view={view?.kind === 'table' ? view : null}
        labels={labels}
        copySelection={copySelection}
      />
    ) : (
      <p>{labels.empty}</p>
    )
  }
  if (viewport.kind !== 'text' || surface.kind !== 'text') {
    return <p>{labels.empty}</p>
  }
  const rows = Array.from(
    { length: Math.min(viewport.lineCount, Math.max(0, surface.lineCount - viewport.startLine)) },
    (_, offset) => viewport.startLine + offset
  )
  return (
    <div
      ref={scroll}
      className="scrollbar-editor relative min-h-0 flex-1 overflow-auto"
      data-viewer-scroll
      onScroll={(event) => {
        const startLine = Math.min(
          Math.max(0, surface.lineCount - 1),
          Math.floor(event.currentTarget.scrollTop / VIEWER_ROW_HEIGHT)
        )
        if (startLine !== viewport.startLine) {
          change({ ...viewport, startLine })
        }
      }}
    >
      {surface.lineCount === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <div className="relative" style={{ height: (surface.lineCount + 1) * VIEWER_ROW_HEIGHT }}>
          <div className="absolute w-full" style={{ top: viewport.startLine * VIEWER_ROW_HEIGHT }}>
            {rows.map((row, offset) => (
              <div
                key={row}
                className="flex gap-4 px-4 font-mono text-xs"
                style={{ height: VIEWER_ROW_HEIGHT, lineHeight: `${VIEWER_ROW_HEIGHT}px` }}
              >
                <span className="w-12 shrink-0 text-right text-muted-foreground">{row + 1}</span>
                <span className="whitespace-pre">
                  {view?.kind === 'text' ? (view.lines[offset] ?? '') : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
