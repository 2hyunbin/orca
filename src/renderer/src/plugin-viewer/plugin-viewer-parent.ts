import { z } from 'zod'
import { createBrowserUuid } from '../lib/browser-uuid'
import { createPanelMessageBudget } from '../../../shared/plugins/plugin-panel-message-budget'
import { pluginViewerInitializeResponseSchema } from '../../../shared/plugins/plugin-viewer-initialize'
import { pluginViewerReadResponseSchema } from '../../../shared/plugins/plugin-viewer-document'
import {
  parsePluginViewerFrameRequest,
  pluginViewerChromeSchema,
  type PluginViewerFrameResponse,
  type PluginViewerStatus
} from '../../../shared/plugins/plugin-viewer-frame-protocol'
import { PLUGIN_VIEWER_WORKER_VERSION } from '../../../shared/plugins/plugin-viewer-worker-protocol'

declare global {
  interface Window {
    orcaFileViewerHost: {
      initialize(): Promise<unknown>
      read(request: unknown): Promise<unknown>
      copySelection(): Promise<unknown>
      notify(status: PluginViewerStatus): void
    }
  }
}

const configuration = z
  .strictObject({
    frame: z.string().min(1),
    chrome: pluginViewerChromeSchema
  })
  .parse(JSON.parse(document.getElementById('viewer-configuration')?.textContent ?? 'null'))
const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts')
frame.setAttribute('title', configuration.chrome.labels.title)
frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
const attempts = createPanelMessageBudget({ maxMessages: 1024, perMs: 10_000 })
const reads = new Set<number>()
let lastRead = 0
let lastCopy = 0
let copying = false
let started = false
let failed = false
const send = (message: PluginViewerFrameResponse): void => {
  if (!failed) {
    frame.contentWindow?.postMessage(message, '*')
  }
}
const fail = (): void => {
  if (failed) {
    return
  }
  failed = true
  window.orcaFileViewerHost.notify({ type: 'error', code: 'invalid_output' })
  frame.remove()
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  if (failed || event.source !== frame.contentWindow) {
    return
  }
  if (attempts.admit(Date.now(), 0)) {
    fail()
    return
  }
  const message = parsePluginViewerFrameRequest(event.data)
  if (!message) {
    fail()
    return
  }
  if (message.type === 'frame-ready') {
    if (started) {
      fail()
      return
    }
    started = true
    window.orcaFileViewerHost.notify({ type: 'loading' })
    void window.orcaFileViewerHost
      .initialize()
      .then((raw) => {
        const initialized = pluginViewerInitializeResponseSchema.safeParse(raw)
        if (!initialized.success) {
          fail()
          return
        }
        send({
          type: 'start',
          chrome: configuration.chrome,
          binding: {
            version: PLUGIN_VIEWER_WORKER_VERSION,
            sessionId: createBrowserUuid(),
            generation: 0
          },
          initialized: initialized.data
        })
      })
      .catch(fail)
    return
  }
  if (!started) {
    fail()
    return
  }
  if (message.type === 'status') {
    window.orcaFileViewerHost.notify(message.status)
    return
  }
  if (message.type === 'copy-selection') {
    if (copying || message.id <= lastCopy) {
      fail()
      return
    }
    lastCopy = message.id
    copying = true
    void window.orcaFileViewerHost
      .copySelection()
      .then((ok) => send({ type: 'copy-result', id: message.id, ok: ok === true }))
      .catch(() => send({ type: 'copy-result', id: message.id, ok: false }))
      .finally(() => {
        copying = false
      })
    return
  }
  if (message.id <= lastRead || reads.size >= 2) {
    fail()
    return
  }
  lastRead = message.id
  reads.add(message.id)
  void window.orcaFileViewerHost
    .read(message.request)
    .then((raw) => {
      const response = pluginViewerReadResponseSchema.safeParse(raw)
      send({
        type: 'read-result',
        id: message.id,
        response: response.success ? response.data : { ok: false, error: 'read_failed' }
      })
    })
    .catch(() =>
      send({
        type: 'read-result',
        id: message.id,
        response: { ok: false, error: 'read_failed' }
      })
    )
    .finally(() => reads.delete(message.id))
})
document.body.append(frame)
frame.srcdoc = configuration.frame
