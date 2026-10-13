import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { Button } from '../components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../components/ui/select'
import '../assets/main.css'
import { createPluginViewerWorkerRuntime } from '../../../shared/plugins/plugin-viewer-worker-runtime'
import {
  isPluginViewerViewportAvailable,
  type PluginViewerSurface,
  type PluginViewerViewport,
  type PluginViewerView
} from '../../../shared/plugins/plugin-viewer-surface'
import type { PluginViewerFrameResponse } from '../../../shared/plugins/plugin-viewer-frame-protocol'
import {
  createPluginViewerFrameTransport,
  sendPluginViewerFrameMessage
} from './plugin-viewer-frame-transport'
import { PluginViewerSurfaceContent } from './plugin-viewer-surface-content'

type Start = Extract<PluginViewerFrameResponse, { type: 'start' }>
const viewerToastStyle: React.CSSProperties & Record<`--${string}`, string> = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
  '--width': 'min(26rem, calc(100vw - 2rem))'
}
function firstViewport(surface: PluginViewerSurface): PluginViewerViewport {
  if (surface.kind === 'text') {
    return { kind: 'text', startLine: 0, lineCount: 64 }
  }
  if (surface.kind === 'table') {
    return {
      kind: 'table',
      sheetId: surface.sheets[0]!.id,
      startRow: 0,
      startColumn: 0,
      rowCount: 1,
      columnCount: 1
    }
  }
  return {
    kind: 'canvas',
    width: Math.min(1024, surface.width),
    height: Math.min(1024, surface.height),
    camera: { yaw: 0, pitch: 0, zoom: 1 }
  }
}

function ViewerFrame({ start }: { start: Start }): React.JSX.Element {
  const [surface, setSurface] = useState<PluginViewerSurface | null>(null)
  const [viewport, setViewport] = useState<PluginViewerViewport | null>(null)
  const [view, setView] = useState<PluginViewerView | null>(null)
  const [failed, setFailed] = useState(!start.initialized.ok)
  const runtime = useRef<ReturnType<typeof createPluginViewerWorkerRuntime> | null>(null)
  const requested = useRef<PluginViewerViewport | null>(null)
  const queued = useRef<PluginViewerViewport | null>(null)
  const labels = start.chrome.labels
  useEffect(() => {
    if (!start.initialized.ok) {
      sendPluginViewerFrameMessage({
        type: 'status',
        status: { type: 'error', code: start.initialized.error }
      })
      return
    }
    document.documentElement.classList.toggle('dark', start.chrome.dark)
    const initialized = start.initialized.result
    let created: ReturnType<typeof createPluginViewerWorkerRuntime>
    try {
      created = createPluginViewerWorkerRuntime(initialized.source, {
        binding: start.binding,
        document: initialized.document,
        read: transport.read,
        onReady(value) {
          setSurface(value)
          const restored = start.chrome.viewport
          setViewport(
            restored && isPluginViewerViewportAvailable(value, restored)
              ? restored
              : firstViewport(value)
          )
        },
        onView(value) {
          setView(value)
          if (requested.current) {
            sendPluginViewerFrameMessage({
              type: 'status',
              status: { type: 'ready', viewport: requested.current }
            })
          }
        },
        onError(code) {
          setFailed(true)
          sendPluginViewerFrameMessage({ type: 'status', status: { type: 'error', code } })
        }
      })
    } catch {
      setFailed(true)
      sendPluginViewerFrameMessage({
        type: 'status',
        status: { type: 'error', code: 'parse_failed' }
      })
      return
    }
    runtime.current = created
    // Throttle without postponing every frame until a drag or scroll ends.
    const timer = setInterval(() => {
      const value = queued.current
      if (value) {
        queued.current = null
        requested.current = value
        created.host.requestViewport(value)
      }
    }, 100)
    return () => {
      clearInterval(timer)
      runtime.current = null
      created.dispose()
    }
  }, [start])
  useEffect(() => {
    queued.current = !failed ? viewport : null
  }, [viewport, failed])
  const change = (value: PluginViewerViewport): void => {
    setView(null)
    setViewport(value)
  }
  if (failed) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
        role="alert"
      >
        {labels.failed}
      </div>
    )
  }
  if (!surface || !viewport) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
        role="status"
      >
        {labels.loading}
      </div>
    )
  }
  const count =
    surface.kind === 'text'
      ? surface.lineCount
      : surface.kind === 'table'
        ? (surface.sheets.find(
            (sheet) => viewport.kind === 'table' && sheet.id === viewport.sheetId
          )?.rowCount ?? 0)
        : 0
  const position =
    viewport.kind === 'text'
      ? viewport.startLine
      : viewport.kind === 'table'
        ? viewport.startRow
        : 0
  const pageSize = viewport.kind === 'table' ? viewport.rowCount : 64
  const page = (delta: number): void => {
    const row = Math.max(0, Math.min(Math.max(0, count - 1), position + delta * pageSize))
    if (viewport.kind === 'text') {
      change({ ...viewport, startLine: row })
    }
    if (viewport.kind === 'table') {
      change({ ...viewport, startRow: row })
    }
  }
  const zoom = (factor: number): void => {
    if (viewport.kind === 'canvas') {
      change({
        ...viewport,
        camera: {
          ...viewport.camera,
          zoom: Math.max(0.05, Math.min(20, viewport.camera.zoom * factor))
        }
      })
    }
  }
  return (
    <main
      className="flex h-full min-h-0 flex-col bg-editor-surface text-foreground"
      data-viewer-kind={surface.kind}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {surface.kind === 'table' && viewport.kind === 'table' && (
          <Select
            value={viewport.sheetId}
            onValueChange={(sheetId) =>
              change({ ...viewport, sheetId, startRow: 0, startColumn: 0 })
            }
          >
            <SelectTrigger size="sm" className="w-48" aria-label={labels.sheet}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {surface.sheets.map((sheet) => (
                <SelectItem key={sheet.id} value={sheet.id}>
                  {sheet.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {viewport.kind === 'canvas' ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => zoom(1 / 1.25)}
              aria-label={labels.zoomOut}
            >
              −
            </Button>
            <span className="min-w-12 text-center text-xs text-muted-foreground">
              {Math.round(viewport.camera.zoom * 100)}%
            </span>
            <Button variant="ghost" size="xs" onClick={() => zoom(1.25)} aria-label={labels.zoomIn}>
              +
            </Button>
            <Button variant="ghost" size="xs" onClick={() => change(firstViewport(surface))}>
              {labels.reset}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" disabled={position === 0} onClick={() => page(-1)}>
              {labels.previous}
            </Button>
            <span className="text-xs text-muted-foreground">
              {count === 0 ? 0 : position + 1}–{Math.min(count, position + pageSize)} / {count}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={position + pageSize >= count}
              onClick={() => page(1)}
            >
              {labels.next}
            </Button>
          </>
        )}
      </div>
      <PluginViewerSurfaceContent
        surface={surface}
        viewport={viewport}
        view={view}
        labels={labels}
        change={change}
        copySelection={transport.copySelection}
      />
      <Toaster
        theme={start.chrome.dark ? 'dark' : 'light'}
        className="toaster group"
        style={viewerToastStyle}
      />
    </main>
  )
}

const mount = document.createElement('div')
mount.style.height = '100%'
document.body.append(mount)
document.documentElement.style.height = '100%'
document.body.style.cssText = 'height:100%;margin:0;overflow:hidden'
const root = createRoot(mount)
const transport = createPluginViewerFrameTransport((start) =>
  root.render(<ViewerFrame start={start} />)
)
addEventListener(
  'pagehide',
  () => {
    root.unmount()
    transport.dispose()
  },
  { once: true }
)
sendPluginViewerFrameMessage({ type: 'frame-ready' })
