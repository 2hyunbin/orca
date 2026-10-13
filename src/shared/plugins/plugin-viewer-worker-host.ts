import { createPanelMessageBudget } from './plugin-panel-message-budget'
import {
  PluginViewerDocumentError,
  pluginViewerDocumentInfoSchema,
  pluginViewerReadResponseSchema,
  type PluginViewerDocumentErrorCode,
  type PluginViewerDocumentInfo,
  type PluginViewerReadRequest,
  type PluginViewerReadResponse
} from './plugin-viewer-document'
import {
  isPluginViewerViewForViewport,
  isPluginViewerViewportAvailable,
  pluginViewerViewportSchema,
  type PluginViewerSurface,
  type PluginViewerView,
  type PluginViewerViewport
} from './plugin-viewer-surface'
import {
  PLUGIN_VIEWER_WORKER_ATTEMPT_LIMIT,
  PLUGIN_VIEWER_WORKER_CONTROL_RATE_LIMIT,
  PLUGIN_VIEWER_WORKER_PARSE_MS,
  PLUGIN_VIEWER_WORKER_PENDING_READS,
  PLUGIN_VIEWER_WORKER_READ_RATE_LIMIT,
  PLUGIN_VIEWER_WORKER_VIEW_MS,
  parsePluginViewerWorkerRequest,
  pluginViewerWorkerBindingSchema,
  type PluginViewerWorkerBinding,
  type PluginViewerWorkerErrorCode,
  type PluginViewerWorkerRequest,
  type PluginViewerWorkerResponse
} from './plugin-viewer-worker-protocol'
import { PluginViewerWorkerLiveness } from './plugin-viewer-worker-liveness'

export type PluginViewerWorkerFailure =
  | PluginViewerWorkerErrorCode
  | PluginViewerDocumentErrorCode
  | 'unresponsive'
  | 'invalid_output'
export type PluginViewerWorkerPort = {
  postMessage(message: PluginViewerWorkerResponse): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'error' | 'messageerror', listener: () => void): void
  terminate(): void
}

export type PluginViewerWorkerHostOptions = {
  binding: PluginViewerWorkerBinding
  document: PluginViewerDocumentInfo
  read(request: PluginViewerReadRequest, signal: AbortSignal): Promise<PluginViewerReadResponse>
  onReady(surface: PluginViewerSurface): void
  onView(view: PluginViewerView): void
  onError(code: PluginViewerWorkerFailure): void
}

export class PluginViewerWorkerHost {
  private readonly binding: PluginViewerWorkerBinding
  private readonly document: PluginViewerDocumentInfo
  private readonly abort = new AbortController()
  private readonly attempts = createPanelMessageBudget(PLUGIN_VIEWER_WORKER_ATTEMPT_LIMIT)
  private readonly controls = createPanelMessageBudget(PLUGIN_VIEWER_WORKER_CONTROL_RATE_LIMIT)
  private readonly bulk = createPanelMessageBudget(PLUGIN_VIEWER_WORKER_READ_RATE_LIMIT)
  private readonly liveness: PluginViewerWorkerLiveness
  private readonly reads = new Set<number>()
  private lastReadId = 0
  private nextViewId = 0
  private surface: PluginViewerSurface | null = null
  private viewRequest: { id: number; viewport: PluginViewerViewport } | null = null
  private queuedViewport: PluginViewerViewport | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly worker: PluginViewerWorkerPort,
    private readonly options: PluginViewerWorkerHostOptions
  ) {
    this.binding = pluginViewerWorkerBindingSchema.parse(options.binding)
    this.document = pluginViewerDocumentInfoSchema.parse(options.document)
    this.liveness = new PluginViewerWorkerLiveness(
      (pulse) => this.send({ ...this.binding, type: 'pulse', pulse }),
      () => this.fail('unresponsive')
    )
    worker.addEventListener('message', this.onMessage)
    worker.addEventListener('error', this.onWorkerError)
    worker.addEventListener('messageerror', this.onWorkerError)
    this.startDeadline(PLUGIN_VIEWER_WORKER_PARSE_MS)
    const { documentHandle: _handle, ...document } = this.document
    this.send({ ...this.binding, type: 'initialize', document })
  }

  requestViewport(value: PluginViewerViewport): boolean {
    const parsed = pluginViewerViewportSchema.safeParse(value)
    if (
      this.closed ||
      !this.surface ||
      !parsed.success ||
      !isPluginViewerViewportAvailable(this.surface, parsed.data)
    ) {
      return false
    }
    if (this.viewRequest) {
      this.queuedViewport = parsed.data
      return true
    }
    if (this.nextViewId >= Number.MAX_SAFE_INTEGER) {
      this.fail('limit_exceeded')
      return false
    }
    this.viewRequest = { id: ++this.nextViewId, viewport: parsed.data }
    this.startDeadline(PLUGIN_VIEWER_WORKER_VIEW_MS)
    this.send({
      ...this.binding,
      type: 'viewport',
      requestId: this.viewRequest.id,
      viewport: parsed.data
    })
    return !this.closed
  }

  dispose(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.abort.abort()
    this.clearDeadline()
    this.liveness.dispose()
    this.queuedViewport = null
    this.viewRequest = null
    this.reads.clear()
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('error', this.onWorkerError)
    this.worker.removeEventListener('messageerror', this.onWorkerError)
    this.worker.terminate()
  }

  private readonly onWorkerError = (): void => {
    this.fail('parse_failed')
  }
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (this.closed) {
      return
    }
    // Charge every attempt before inspecting author-controlled data.
    if (this.attempts.admit(Date.now(), 0)) {
      this.fail('limit_exceeded')
      return
    }
    const message = parsePluginViewerWorkerRequest(event.data)
    if (
      !message ||
      message.sessionId !== this.binding.sessionId ||
      message.generation !== this.binding.generation ||
      message.version !== this.binding.version
    ) {
      this.fail('invalid_output')
      return
    }
    if (message.type === 'alive') {
      if (!this.liveness.acknowledge(message.pulse)) {
        this.fail('invalid_output')
      }
      return
    }
    const budget = message.type === 'read' ? this.bulk : this.controls
    if (budget.admit(Date.now(), 0)) {
      this.fail('limit_exceeded')
      return
    }
    if (message.type === 'read') {
      void this.read(message)
      return
    }
    if (message.type === 'error') {
      if (message.requestId !== undefined && message.requestId !== this.viewRequest?.id) {
        this.fail('invalid_output')
      } else {
        this.fail(message.code)
      }
      return
    }
    if (message.type === 'ready') {
      if (this.surface || this.reads.size > 0) {
        this.fail('invalid_output')
        return
      }
      this.clearDeadline()
      this.surface = message.surface
      this.options.onReady(structuredClone(message.surface))
      return
    }
    const pending = this.viewRequest
    if (
      !pending ||
      !this.surface ||
      message.requestId !== pending.id ||
      !isPluginViewerViewForViewport(this.surface, pending.viewport, message.view)
    ) {
      this.fail('invalid_output')
      return
    }
    this.clearDeadline()
    this.viewRequest = null
    const queued = this.queuedViewport
    this.queuedViewport = null
    // A newer viewport supersedes a late reply, even when the reply itself is valid.
    if (!queued) {
      this.options.onView(message.view)
    }
    if (queued && !this.closed) {
      this.requestViewport(queued)
    }
  }

  private async read(message: Extract<PluginViewerWorkerRequest, { type: 'read' }>): Promise<void> {
    if (
      (!this.deadline && !this.viewRequest) ||
      message.requestId <= this.lastReadId ||
      message.position > this.document.size ||
      this.reads.size >= PLUGIN_VIEWER_WORKER_PENDING_READS
    ) {
      this.fail(
        this.reads.size >= PLUGIN_VIEWER_WORKER_PENDING_READS ? 'limit_exceeded' : 'invalid_output'
      )
      return
    }
    this.lastReadId = message.requestId
    this.reads.add(message.requestId)
    try {
      const raw = await this.options.read(
        {
          documentHandle: this.document.documentHandle,
          revision: this.document.revision,
          position: message.position,
          length: message.length
        },
        this.abort.signal
      )
      if (this.closed) {
        return
      }
      const response = pluginViewerReadResponseSchema.safeParse(raw)
      if (!response.success) {
        this.fail('read_failed')
        return
      }
      if (
        response.data.ok &&
        (response.data.result.revision !== this.document.revision ||
          response.data.result.bytesRead >
            Math.min(message.length, this.document.size - message.position) ||
          response.data.result.eof !==
            (message.position + response.data.result.bytesRead === this.document.size))
      ) {
        this.fail('stale_revision')
        return
      }
      this.send({
        ...this.binding,
        type: 'read-result',
        requestId: message.requestId,
        response: response.data
      })
      if (!response.data.ok) {
        this.fail(response.data.error)
      }
    } catch (error) {
      this.fail(error instanceof PluginViewerDocumentError ? error.code : 'read_failed')
    } finally {
      this.reads.delete(message.requestId)
    }
  }

  private send(message: PluginViewerWorkerResponse): void {
    if (this.closed) {
      return
    }
    try {
      this.worker.postMessage(message)
    } catch {
      this.fail('parse_failed')
    }
  }

  private startDeadline(ms: number): void {
    this.clearDeadline()
    this.deadline = setTimeout(() => this.fail('unresponsive'), ms)
  }

  private clearDeadline(): void {
    if (this.deadline !== null) {
      clearTimeout(this.deadline)
    }
    this.deadline = null
  }

  private fail(code: PluginViewerWorkerFailure): void {
    if (this.closed) {
      return
    }
    this.dispose()
    this.options.onError(code)
  }
}
