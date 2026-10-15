import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'

const WORKER_FILENAME = 'journal-maintenance-worker-entry.js'

function workerPath(): string {
  const entry = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  return [entry, join(dirname(entry), '..', WORKER_FILENAME)].find(existsSync) ?? entry
}

/** SQLite commits and page relocation must never execute on the host's interaction thread. */
export class JournalMaintenanceWorker {
  private worker: Worker | null = null
  private wakeController: AbortController | null = null
  private closed = false

  constructor(private readonly dbPath: string) {
    this.wake()
  }

  appended(sessionId: string): void {
    if (this.worker) {
      this.worker.postMessage(sessionId)
    } else {
      this.wake()
    }
  }

  changed(): void {
    if (this.worker) {
      this.worker.postMessage(null)
    } else {
      this.wake()
    }
  }

  close(): void {
    this.closed = true
    this.wakeController?.abort()
    this.wakeController = null
    // Close after the current bounded transaction; termination can interrupt SQLite teardown.
    this.worker?.postMessage({ close: true })
    this.worker = null
  }

  private wake(): void {
    if (this.closed || this.wakeController) {
      return
    }
    const controller = new AbortController()
    this.wakeController = controller
    void delay(30_000, undefined, { ref: false, signal: controller.signal })
      .then(() => {
        this.wakeController = null
        if (this.closed) {
          return
        }
        const worker = new Worker(workerPath(), {
          workerData: this.dbPath,
          execArgv: []
        })
        this.worker = worker
        worker.on('error', (error) => console.warn('[journal-maintenance] worker failed:', error))
        worker.once('exit', () => {
          if (this.worker === worker) {
            this.worker = null
          }
        })
        worker.unref()
      })
      .catch((error) => {
        this.wakeController = null
        if (!controller.signal.aborted) {
          console.warn('[journal-maintenance] unavailable:', error)
        }
      })
  }
}
