import { setImmediate as afterRetirement } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { WorkerThreadRequestQueue } from '../../worker-thread-request-queue'
import type { WorkerRequestTransport } from '../../lazy-worker-thread-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'
import type { JournalHostDatabase } from './journal-host-database'
import type {
  LegacyRestExecutor,
  LegacyRestRequest,
  LegacyRestResponse
} from './journal-legacy-rest-worker-protocol'

export class JournalLegacyRestWorker implements LegacyRestExecutor {
  private queue?: WorkerThreadRequestQueue<LegacyRestRequest, LegacyRestResponse>
  private retirement: Promise<unknown> = Promise.resolve()
  private readonly owner = { signal: new AbortController().signal }
  private closed = false

  constructor(
    private readonly database: JournalHostDatabase,
    private readonly control: Int32Array,
    private readonly charge: (ms: number) => void = () => undefined
  ) {}

  async grant(request: Omit<LegacyRestRequest, 'id'>): Promise<LegacyRestResponse> {
    await this.retirement
    await afterRetirement()
    if (this.closed) {
      throw new Error('legacy worker is closed')
    }
    const started = performance.now()
    this.queue ??= this.createQueue()
    let id = 0
    const pending = this.queue.dispatch(
      (next) => {
        id = next
        return { ...request, id }
      },
      5 * 60_000,
      undefined,
      this.owner
    )
    this.charge(performance.now() - started)
    const response = await pending
    const received = performance.now()
    try {
      if (
        !response ||
        response.id !== id ||
        response.generation !== request.generation ||
        response.sessionId !== request.sessionId ||
        response.guard !== (request.source?.guard ?? '') ||
        ![
          'progress',
          'paused',
          'drift',
          'complete',
          'clean',
          'found',
          'exhausted',
          'failed'
        ].includes(response.status) ||
        !Number.isSafeInteger(response.cursor) ||
        response.cursor < 0 ||
        (request.source && response.cursor > request.source.tip) ||
        typeof response.pending !== 'boolean' ||
        !Number.isFinite(response.occupiedMs) ||
        response.occupiedMs < 0 ||
        (response.status === 'found' && typeof response.candidate !== 'string') ||
        (response.status === 'complete' &&
          (response.cursor !== request.source?.tip ||
            response.pending ||
            (response.fact !== null &&
              (!response.fact ||
                typeof response.fact.itemId !== 'string' ||
                typeof response.fact.since !== 'number'))))
      ) {
        throw new Error('legacy worker returned an invalid or stale result')
      }
    } finally {
      this.charge(performance.now() - received)
    }
    return response
  }

  async retire(): Promise<void> {
    const started = performance.now()
    try {
      this.queue?.dispose()
      this.queue = undefined
    } finally {
      this.charge(performance.now() - started)
    }
    await this.retirement
  }

  async close(): Promise<void> {
    this.closed = true
    await this.retire()
  }

  private createQueue(): WorkerThreadRequestQueue<LegacyRestRequest, LegacyRestResponse> {
    return new WorkerThreadRequestQueue({
      factory: () => this.createWorker(),
      idleTeardownMs: 60_000,
      maxConsecutiveDeaths: 2,
      awaitRetirement: true,
      queueCap: { maxQueuedCalls: 1, describeFull: () => 'legacy grant already queued' },
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `legacy worker timed out after ${ms}ms`,
      describeExit: (code) => `legacy worker exited with ${code}`,
      describeCrashLoop: (message) => `legacy worker failed repeatedly: ${message}`,
      onUnavailable: () => undefined
    })
  }

  private createWorker(): WorkerRequestTransport {
    const path = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-legacy-rest-worker-entry.js'
    )
    const worker = new Worker(path, {
      workerData: { directory: this.database.stateDirectory, control: this.control }
    })
    let exited = false
    let exitCode = 0
    worker.on('exit', (code) => {
      exited = true
      exitCode = code
    })
    return {
      unref: () => worker.unref(),
      postMessage: (message) => worker.postMessage(message),
      on: (...args) => worker.on(...args),
      off: (...args) => worker.off(...args),
      removeAllListeners: () => worker.removeAllListeners(),
      terminate: () => {
        if (exited) {
          return Promise.resolve(exitCode)
        }
        let actual: Promise<number>
        try {
          actual = worker.terminate()
        } catch (error) {
          actual = Promise.reject(error)
        }
        this.retirement = actual
        // Observe rejection without converting unproved retirement into replacement permission.
        void actual.catch(() => undefined)
        return actual
      }
    }
  }
}
