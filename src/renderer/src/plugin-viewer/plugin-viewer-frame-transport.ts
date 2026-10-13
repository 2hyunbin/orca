import {
  pluginViewerFrameResponseSchema,
  type PluginViewerFrameRequest,
  type PluginViewerFrameResponse
} from '../../../shared/plugins/plugin-viewer-frame-protocol'
import type {
  PluginViewerReadRequest,
  PluginViewerReadResponse
} from '../../../shared/plugins/plugin-viewer-document'

export function sendPluginViewerFrameMessage(message: PluginViewerFrameRequest): void {
  parent.postMessage(message, '*')
}

export function createPluginViewerFrameTransport(
  start: (message: Extract<PluginViewerFrameResponse, { type: 'start' }>) => void
): {
  read(request: PluginViewerReadRequest, signal: AbortSignal): Promise<PluginViewerReadResponse>
  copySelection(): Promise<boolean>
  dispose(): void
} {
  const pending = new Map<
    number,
    {
      complete(response: PluginViewerReadResponse): void
      abort(): void
    }
  >()
  let nextId = 0
  let started = false
  let closed = false
  let copying: { id: number; complete(ok: boolean): void } | undefined
  const receive = (event: MessageEvent<unknown>): void => {
    if (closed || event.source !== parent) {
      return
    }
    const message = pluginViewerFrameResponseSchema.safeParse(event.data)
    if (!message.success) {
      return
    }
    if (message.data.type === 'start') {
      if (!started) {
        started = true
        start(message.data)
      }
    } else if (message.data.type === 'copy-result') {
      if (copying?.id === message.data.id) {
        copying.complete(message.data.ok)
      }
    } else {
      pending.get(message.data.id)?.complete(message.data.response)
    }
  }
  addEventListener('message', receive)
  return {
    copySelection() {
      if (closed || !started || copying) {
        return Promise.resolve(false)
      }
      const id = ++nextId
      return new Promise((resolve) => {
        const timer = setTimeout(() => complete(false), 5000)
        const complete = (ok: boolean): void => {
          clearTimeout(timer)
          copying = undefined
          resolve(ok)
        }
        copying = { id, complete }
        sendPluginViewerFrameMessage({ type: 'copy-selection', id })
      })
    },
    read(request, signal) {
      if (closed || signal.aborted || pending.size >= 2) {
        return Promise.resolve({ ok: false, error: 'cancelled' })
      }
      const id = ++nextId
      return new Promise((resolve) => {
        const complete = (response: PluginViewerReadResponse): void => {
          pending.delete(id)
          signal.removeEventListener('abort', abort)
          resolve(response)
        }
        const abort = (): void => complete({ ok: false, error: 'cancelled' })
        pending.set(id, { complete, abort })
        signal.addEventListener('abort', abort, { once: true })
        sendPluginViewerFrameMessage({ type: 'read', id, request })
      })
    },
    dispose() {
      closed = true
      removeEventListener('message', receive)
      copying?.complete(false)
      for (const entry of pending.values()) {
        entry.abort()
      }
    }
  }
}
