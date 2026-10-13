import {
  PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS,
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT,
  PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS,
  PLUGIN_GRAMMAR_QUEUE_LIMIT,
  isValidPluginGrammarTokenData,
  pluginGrammarResponseSchema,
  type PluginGrammarRequest,
  type PluginGrammarSource
} from '../../../../shared/plugins/plugin-grammar-protocol'
import { PluginGrammarFailure, type PluginGrammarFailureReason } from './plugin-grammar-failure'

export type PluginGrammarWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

type Job = {
  request: PluginGrammarRequest
  signal: AbortSignal
  resolve: (data: Uint32Array | null) => void
  reject: (failure: PluginGrammarFailure) => void
  abort: () => void
  timeout?: ReturnType<typeof setTimeout>
  deadline?: ReturnType<typeof setTimeout>
}

export class PluginGrammarWorkerClient {
  private readonly queue: Job[] = []
  private worker: PluginGrammarWorker | null = null
  private active: Job | null = null
  private disposed = false
  private nextId = 1
  private startedWorkers = 0
  private timedOutWorkers = 0
  private completedDocuments = 0

  constructor(
    private readonly scopeName: string,
    private readonly grammars: readonly PluginGrammarSource[],
    private readonly createWorker: () => PluginGrammarWorker
  ) {}

  diagnostics(): { startedWorkers: number; timedOutWorkers: number; completedDocuments: number } {
    return {
      startedWorkers: this.startedWorkers,
      timedOutWorkers: this.timedOutWorkers,
      completedDocuments: this.completedDocuments
    }
  }

  tokenize(
    text: string,
    version: number,
    generation: number,
    signal: AbortSignal
  ): Promise<Uint32Array | null> {
    return this.tokenizeChecked(text, version, generation, signal).catch(() => null)
  }

  tokenizeChecked(
    text: string,
    version: number,
    generation: number,
    signal: AbortSignal
  ): Promise<Uint32Array | null> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve(null)
    }
    if (
      text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT ||
      text.split(/\r\n|\r|\n/).length > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
    ) {
      return Promise.reject(new PluginGrammarFailure('size'))
    }
    if (this.queue.length >= PLUGIN_GRAMMAR_QUEUE_LIMIT) {
      return Promise.reject(new PluginGrammarFailure('capacity'))
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        request: {
          id: this.nextId++,
          scopeName: this.scopeName,
          grammars: this.grammars,
          text,
          version,
          generation
        },
        signal,
        resolve,
        reject,
        abort: () => this.cancel(job)
      }
      signal.addEventListener('abort', job.abort, { once: true })
      this.queue.push(job)
      this.startNext()
    })
  }

  dispose(): void {
    this.disposed = true
    this.stopWorker()
    if (this.active) {
      this.settle(this.active, null)
    }
    for (const job of this.queue.splice(0)) {
      this.settle(job, null)
    }
  }

  releaseIdleWorker(): void {
    if (!this.active && this.queue.length === 0) {
      this.stopWorker()
    }
  }

  private startNext(): void {
    if (this.disposed || this.active) {
      return
    }
    const job = this.queue.shift()
    if (!job) {
      return
    }
    this.active = job
    try {
      if (!this.worker) {
        const worker = this.createWorker()
        this.worker = worker
        this.startedWorkers++
        worker.onmessage = (event) => {
          if (this.worker === worker) {
            this.receive(event.data)
          }
        }
        worker.onerror = () => {
          if (this.worker === worker) {
            this.failActive()
          }
        }
      }
      this.refreshProgressDeadline(job)
      job.deadline = setTimeout(() => this.timeoutActive(), PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS)
      this.worker.postMessage(job.request)
    } catch {
      this.failActive()
    }
  }

  private receive(raw: unknown): void {
    const parsed = pluginGrammarResponseSchema.safeParse(raw)
    const job = this.active
    if (!job) {
      return
    }
    if (!parsed.success) {
      this.failActive()
      return
    }
    const response = parsed.data
    if (
      response.id !== job.request.id ||
      response.generation !== job.request.generation ||
      response.version !== job.request.version
    ) {
      return
    }
    if (response.type === 'progress') {
      this.refreshProgressDeadline(job)
      return
    }
    const data =
      response.type === 'complete' && isValidPluginGrammarTokenData(response.data, job.request.text)
        ? response.data
        : null
    if (data) {
      this.completedDocuments++
    } else {
      this.failActive()
      return
    }
    this.settle(job, data)
    this.startNext()
  }

  private refreshProgressDeadline(job: Job): void {
    clearTimeout(job.timeout)
    job.timeout = setTimeout(() => this.timeoutActive(), PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS)
  }

  private timeoutActive(): void {
    this.timedOutWorkers++
    this.failActive('budget')
  }

  private failActive(reason: PluginGrammarFailureReason = 'worker'): void {
    this.stopWorker()
    if (this.active) {
      this.settle(this.active, null, reason)
    }
    this.startNext()
  }

  private cancel(job: Job): void {
    if (this.active === job) {
      this.failActive()
      return
    }
    const index = this.queue.indexOf(job)
    if (index !== -1) {
      this.queue.splice(index, 1)
      this.settle(job, null)
    }
  }

  private settle(job: Job, data: Uint32Array | null, reason?: PluginGrammarFailureReason): void {
    clearTimeout(job.timeout)
    clearTimeout(job.deadline)
    job.signal.removeEventListener('abort', job.abort)
    if (this.active === job) {
      this.active = null
    }
    if (reason && !job.signal.aborted) {
      job.reject(new PluginGrammarFailure(reason))
    } else {
      job.resolve(data)
    }
  }

  private stopWorker(): void {
    if (!this.worker) {
      return
    }
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    this.worker = null
  }
}
