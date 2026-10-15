import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  private timer: ReturnType<typeof setTimeout> | null = null
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
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Close after the current bounded transaction; termination can interrupt SQLite teardown.
    this.worker?.postMessage({ close: true })
    this.worker = null
  }

  private wake(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.closed) return
      try {
        const worker = new Worker(workerPath(), {
          workerData: this.dbPath,
          execArgv: []
        })
        this.worker = worker
        worker.on('error', (error) => console.warn('[journal-maintenance] worker failed:', error))
        worker.once('exit', () => {
          if (this.worker === worker) this.worker = null
        })
        worker.unref()
      } catch (error) {
        console.warn('[journal-maintenance] unavailable:', error)
      }
    }, 30_000)
    this.timer.unref()
  }
}
