import { useEffect, useRef, type PointerEvent } from 'react'
import type {
  PluginViewerView,
  PluginViewerViewport
} from '../../../shared/plugins/plugin-viewer-surface'

export function PluginViewerCanvas({
  view,
  viewport,
  change,
  label
}: {
  label: string
  view: Extract<PluginViewerView, { kind: 'canvas' }> | null
  viewport: Extract<PluginViewerViewport, { kind: 'canvas' }>
  change(viewport: PluginViewerViewport): void
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!view) {
      return
    }
    const context = canvas.current?.getContext('2d')
    context?.putImageData(
      new ImageData(new Uint8ClampedArray(view.pixels), view.width, view.height),
      0,
      0
    )
  }, [view])
  const orbit = (yaw: number, pitch: number): void =>
    change({
      ...viewport,
      camera: {
        ...viewport.camera,
        yaw: Math.max(-360, Math.min(360, yaw)),
        pitch: Math.max(-90, Math.min(90, pitch))
      }
    })
  const release = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (drag.current?.id === event.pointerId) {
      drag.current = null
    }
  }
  return (
    <canvas
      ref={canvas}
      width={viewport.width}
      height={viewport.height}
      tabIndex={0}
      className="max-h-full max-w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={label}
      role="img"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      }}
      onPointerMove={(event) => {
        const previous = drag.current
        if (!previous || previous.id !== event.pointerId) {
          return
        }
        orbit(
          viewport.camera.yaw + (event.clientX - previous.x) / 2,
          viewport.camera.pitch + (event.clientY - previous.y) / 2
        )
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 15 : 5
        if (event.key === 'ArrowLeft') {
          orbit(viewport.camera.yaw - step, viewport.camera.pitch)
        } else if (event.key === 'ArrowRight') {
          orbit(viewport.camera.yaw + step, viewport.camera.pitch)
        } else if (event.key === 'ArrowUp') {
          orbit(viewport.camera.yaw, viewport.camera.pitch - step)
        } else if (event.key === 'ArrowDown') {
          orbit(viewport.camera.yaw, viewport.camera.pitch + step)
        } else {
          return
        }
        event.preventDefault()
      }}
    />
  )
}
