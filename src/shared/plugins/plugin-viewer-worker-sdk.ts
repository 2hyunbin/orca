import type { PluginViewerDocumentErrorCode } from './plugin-viewer-document'
import type { PluginViewerWorkerSdk, PluginViewerAdapter } from './plugin-viewer-author-api'
import type {
  PluginViewerWorkerDocument,
  PluginViewerWorkerErrorCode,
  PluginViewerWorkerResponse
} from './plugin-viewer-worker-protocol'

export type { PluginViewerAdapter, PluginViewerWorkerSdk } from './plugin-viewer-author-api'

type SdkScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<PluginViewerWorkerResponse>) => void
  ): void
}

// Self-contained: its compiled function is installed before the separate author script imports.
export function installPluginViewerWorkerSdk(scope: SdkScope): void {
  const send = scope.postMessage.bind(scope)
  const listen = scope.addEventListener.bind(scope)
  const freeze = Object.freeze
  const define = Object.defineProperty
  const decode = globalThis.atob.bind(globalThis)
  const Bytes = Uint8Array
  const BufferType = ArrayBuffer
  const pending = new Map<
    number,
    {
      resolve(bytes: Uint8Array): void
      reject(error: Error): void
      length: number
    }
  >()
  let binding: { version: 1; sessionId: string; generation: number } | null = null
  let document: Readonly<PluginViewerWorkerDocument> | null = null
  let adapter: PluginViewerAdapter | null = null
  let nextId = 0
  let initialized = false
  let ready = false
  let rendering = false
  const fail = (code: PluginViewerDocumentErrorCode | PluginViewerWorkerErrorCode): Error =>
    Object.assign(new Error(code), { code })
  const reportFailure = (error: unknown, requestId?: number): void => {
    const code =
      error instanceof Error &&
      'code' in error &&
      (error.code === 'limit_exceeded' || error.code === 'unsupported_format')
        ? error.code
        : 'parse_failed'
    send({ ...binding, type: 'error', code, ...(requestId === undefined ? {} : { requestId }) })
  }
  const sdk: PluginViewerWorkerSdk = freeze({
    register(value: PluginViewerAdapter): void {
      if (
        adapter ||
        initialized ||
        typeof value?.open !== 'function' ||
        typeof value?.render !== 'function'
      ) {
        throw fail('parse_failed')
      }
      adapter = freeze({ open: value.open.bind(value), render: value.render.bind(value) })
    },
    readBytes(position: number, length: number): Promise<Uint8Array> {
      if (!binding || !document) {
        return Promise.reject(fail('unavailable'))
      }
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 192 * 1024 ||
        !Number.isSafeInteger(position + length) ||
        position > document.size
      ) {
        return Promise.reject(fail('invalid_request'))
      }
      if (pending.size >= 2 || nextId >= Number.MAX_SAFE_INTEGER) {
        return Promise.reject(fail('limit_exceeded'))
      }
      const requestId = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject, length })
        try {
          send({ ...binding, type: 'read', requestId, position, length })
        } catch {
          pending.delete(requestId)
          reject(fail('read_failed'))
        }
      })
    }
  })
  define(globalThis, 'orcaViewer', { value: sdk, writable: false, configurable: false })
  listen('message', (event) => {
    const message = event.data
    if (message.type === 'initialize') {
      if (initialized) {
        return
      }
      initialized = true
      binding = freeze({
        version: message.version,
        sessionId: message.sessionId,
        generation: message.generation
      })
      document = freeze({ ...message.document, features: freeze({ ...message.document.features }) })
      if (!adapter) {
        reportFailure(fail('parse_failed'))
        return
      }
      const activeAdapter = adapter
      const openedDocument = document
      void Promise.resolve()
        .then(() => activeAdapter.open(openedDocument))
        .then((surface) => {
          ready = true
          send({ ...binding, type: 'ready', surface })
        })
        .catch((error: unknown) => reportFailure(error))
      return
    }
    if (
      !binding ||
      message.version !== binding.version ||
      message.sessionId !== binding.sessionId ||
      message.generation !== binding.generation
    ) {
      return
    }
    if (message.type === 'pulse') {
      send({ ...binding, type: 'alive', pulse: message.pulse })
      return
    }
    if (message.type === 'read-result') {
      const request = pending.get(message.requestId)
      if (!request) {
        return
      }
      pending.delete(message.requestId)
      if (!message.response.ok) {
        request.reject(fail(message.response.error))
        return
      }
      const result = message.response.result
      if (result.revision !== document?.revision || result.bytesRead > request.length) {
        request.reject(fail('stale_revision'))
        return
      }
      try {
        const binary = decode(result.contentBase64)
        if (binary.length !== result.bytesRead) {
          throw fail('read_failed')
        }
        const bytes = new Bytes(binary.length)
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index)
        }
        request.resolve(bytes)
      } catch {
        request.reject(fail('read_failed'))
      }
      return
    }
    if (message.type !== 'viewport' || !ready || !adapter || rendering) {
      return
    }
    rendering = true
    const requestId = message.requestId
    const activeAdapter = adapter
    void Promise.resolve()
      .then(() => activeAdapter.render(freeze(message.viewport)))
      .then((view) => {
        const transfer: Transferable[] = []
        if (view.kind === 'canvas') {
          if (!(view.pixels.buffer instanceof BufferType)) {
            throw fail('parse_failed')
          }
          transfer.push(view.pixels.buffer)
        }
        send({ ...binding, type: 'view', requestId, view }, transfer)
      })
      .catch((error: unknown) => reportFailure(error, requestId))
      .finally(() => {
        rendering = false
      })
  })
}
