import {
  pluginViewerDocumentInfoSchema,
  pluginViewerReadResponseSchema,
  type PluginViewerReadResponse
} from '../../shared/plugins/plugin-viewer-document'
import { pluginViewerWorkerBindingSchema } from '../../shared/plugins/plugin-viewer-worker-protocol'
import { createPluginViewerWorkerRuntime } from '../../shared/plugins/plugin-viewer-worker-runtime'

const prefix = String.raw`
function globalThis() {}
let values;
async function load(document) {
  const bytes = await orcaViewer.readBytes(0, document.size);
  if (bytes[0] !== 42) throw Object.assign(new Error('unsupported_format'), {code:'unsupported_format'});
  values = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
}
let sdkLocked = false;
try { Object.defineProperty(self, 'orcaViewer', {value: {}}); } catch { sdkLocked = true; }
if (!sdkLocked) throw new Error('SDK must be immutable');
`
const authors = [
  `${prefix}
  orcaViewer.register({
    async open(document) { await load(document); return {kind:'text', lineCount:values.lines.length}; },
    render(viewport) { return {kind:'text',startLine:viewport.startLine,lines:values.lines.slice(viewport.startLine, viewport.startLine + viewport.lineCount)}; }
  });`,
  `${prefix}
  orcaViewer.register({
    async open(document) { await load(document); return {kind:'table',sheets:[{id:'values',label:'Values',rowCount:1,columnCount:2}]}; },
    render(viewport) { return {kind:'table',sheetId:viewport.sheetId,cells:values.cells}; }
  });`,
  `${prefix}
  orcaViewer.register({
    async open(document) { await load(document); return {kind:'canvas',width:2,height:2}; },
    render(viewport) { return {kind:'canvas',width:viewport.width,height:viewport.height,pixels:new Uint8ClampedArray(values.pixels)}; }
  });`,
  `orcaViewer.register({
    open() { setTimeout(() => { while (true) {} }, 100); return {kind:'text',lineCount:0}; },
    render() { return {kind:'text',startLine:0,lines:[]}; }
  });`
]
const pending = new Map<
  number,
  { resolve(result: PluginViewerReadResponse): void; reject(error: Error): void }
>()
let nextRead = 0
let finished = false

function finish(proof: unknown): void {
  if (finished) {
    return
  }
  finished = true
  parent.postMessage({ type: 'runtime-proof', proof }, '*')
}

addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') {
      return
    }
    if (
      'type' in event.data &&
      event.data.type === 'runtime-read-result' &&
      'id' in event.data &&
      typeof event.data.id === 'number' &&
      'response' in event.data
    ) {
      const request = pending.get(event.data.id)
      if (!request) {
        return
      }
      pending.delete(event.data.id)
      const parsed = pluginViewerReadResponseSchema.safeParse(event.data.response)
      if (parsed.success) {
        request.resolve(parsed.data)
      } else {
        request.reject(new Error('read_failed'))
      }
      return
    }
    if (
      !('type' in event.data) ||
      event.data.type !== 'runtime-start' ||
      !('document' in event.data) ||
      !('binding' in event.data)
    ) {
      return
    }
    const document = pluginViewerDocumentInfoSchema.parse(event.data.document)
    const binding = pluginViewerWorkerBindingSchema.parse(event.data.binding)
    const proofs: unknown[] = []
    const run = (index: number): void => {
      const author = authors[index]
      if (!author) {
        finish({
          surfaces: proofs,
          networkElements: globalThis.document.querySelectorAll('img,a,link,iframe').length
        })
        return
      }
      const runtime = createPluginViewerWorkerRuntime(author, {
        document,
        binding: { ...binding, generation: binding.generation + index },
        read(request, signal) {
          const id = ++nextRead
          return new Promise((resolve, reject) => {
            const abort = (): void => {
              pending.delete(id)
              reject(new Error('cancelled'))
            }
            signal.addEventListener('abort', abort, { once: true })
            pending.set(id, {
              resolve(value) {
                signal.removeEventListener('abort', abort)
                resolve(value)
              },
              reject(error) {
                signal.removeEventListener('abort', abort)
                reject(error)
              }
            })
            parent.postMessage({ type: 'runtime-read', id, request }, '*')
          })
        },
        onReady(surface) {
          if (index === 3) {
            return
          }
          if (surface.kind === 'text') {
            runtime.host.requestViewport({ kind: 'text', startLine: 0, lineCount: 3 })
          } else if (surface.kind === 'table') {
            runtime.host.requestViewport({
              kind: 'table',
              sheetId: 'values',
              startRow: 0,
              startColumn: 0,
              rowCount: 1,
              columnCount: 2
            })
          } else {
            runtime.host.requestViewport({
              kind: 'canvas',
              width: 2,
              height: 2,
              camera: { yaw: 0, pitch: 0, zoom: 1 }
            })
          }
        },
        onView(view) {
          if (view.kind === 'text') {
            const pre = globalThis.document.createElement('pre')
            pre.textContent = view.lines.join('\n')
            globalThis.document.body.append(pre)
            proofs.push({ kind: 'text', text: pre.textContent })
          } else if (view.kind === 'table') {
            const table = globalThis.document.createElement('table')
            const row = table.insertRow()
            for (const cell of view.cells) {
              const element = row.insertCell()
              element.textContent = cell.text
              element.dataset.kind = cell.kind
            }
            globalThis.document.body.append(table)
            proofs.push({
              kind: 'table',
              text: table.textContent,
              cachedFormula: table.querySelector('[data-kind="cached-formula"]')?.textContent
            })
          } else {
            const canvas = globalThis.document.createElement('canvas')
            canvas.width = view.width
            canvas.height = view.height
            const context = canvas.getContext('2d')
            if (!context) {
              finish({ error: 'canvas_unavailable' })
              return
            }
            context.putImageData(
              new ImageData(new Uint8ClampedArray(view.pixels), view.width, view.height),
              0,
              0
            )
            globalThis.document.body.append(canvas)
            proofs.push({
              kind: 'canvas',
              pixels: Array.from(context.getImageData(0, 0, 2, 2).data)
            })
          }
          runtime.dispose()
          run(index + 1)
        },
        onError(code) {
          if (index === 3 && code === 'unresponsive') {
            runtime.dispose()
            finish({
              surfaces: proofs,
              networkElements: globalThis.document.querySelectorAll('img,a,link,iframe').length,
              idleRecovery: code
            })
            return
          }
          finish({ error: code })
        }
      })
    }
    run(0)
  },
  { once: false }
)
