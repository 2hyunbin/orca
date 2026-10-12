import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import {
  WORKER_THREAD_CHILD_SPAWN_FAILED_EXIT_CODE,
  type WorkerThreadChildErrorPayload,
  type WorkerThreadChildEvent,
  type WorkerThreadChildRequest,
  type WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

// Why (#27362): libuv creates processes inline on the calling loop, and on
// Windows CreateProcessW can spend seconds in code integrity hashing a large,
// uncached binary. Spawning from a worker thread keeps that off the UI loop.
// Like the port-scan worker (#11161) this fails closed rather than spawning
// in-process when no worker can be started.

// Starting a worker costs a few ms; a few minutes covers back-to-back probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'

function toError(payload: WorkerThreadChildErrorPayload): Error {
  const error: NodeJS.ErrnoException = new Error(payload.message)
  if (payload.code) {
    error.code = payload.code
  }
  return error
}

class WorkerThreadChildStdin extends EventEmitter {
  constructor(
    private readonly id: number,
    private readonly send: (request: WorkerThreadChildRequest) => void
  ) {
    super()
  }

  write(data: string): boolean {
    this.send({ type: 'stdin-write', id: this.id, data })
    return true
  }

  end(): void {
    this.send({ type: 'stdin-end', id: this.id })
  }
}

/**
 * Main-thread stand-in for a piped ChildProcess whose real process lives on the
 * worker. Mirrors the subset callers use: stdio streams, pid, exit state, kill.
 */
export class WorkerThreadChildProcess extends EventEmitter {
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin: WorkerThreadChildStdin
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(
    readonly id: number,
    private readonly send: (request: WorkerThreadChildRequest) => void
  ) {
    super()
    this.stdin = new WorkerThreadChildStdin(id, send)
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false
    }
    this.send({ type: 'kill', id: this.id, signal })
    return true
  }

  /** @internal Applies one event forwarded from the worker. */
  receive(event: WorkerThreadChildEvent): void {
    switch (event.type) {
      case 'spawn':
        this.pid = event.pid
        this.emit('spawn')
        return
      case 'stdout':
      case 'stderr':
        this[event.type].emit(
          'data',
          Buffer.from(event.chunk.buffer, event.chunk.byteOffset, event.chunk.byteLength)
        )
        return
      case 'error':
        this.emitErrorIfObserved(this, event.error)
        return
      case 'stdin-error':
        this.emitErrorIfObserved(this.stdin, event.error)
        return
      case 'exit':
        this.exitCode = event.code
        this.signalCode = event.signal
        this.emit('exit', event.code, event.signal)
        return
      case 'close':
        this.emit('close', event.code, event.signal)
    }
  }

  /**
   * @internal The worker died. No 'close': the real process may outlive it, so
   * callers must escalate by pid rather than treat the child as gone.
   */
  orphan(payload: WorkerThreadChildErrorPayload): void {
    this.emitErrorIfObserved(this, payload)
  }

  // Why: a late error after the caller detached would otherwise throw inside the
  // worker message handler and surface as an uncaught main-process exception.
  private emitErrorIfObserved(target: EventEmitter, payload: WorkerThreadChildErrorPayload): void {
    if (target.listenerCount('error') > 0) {
      target.emit('error', toError(payload))
    }
  }
}

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
  private nextId = 1

  constructor(factory: WorkerThreadFactory, log: (message: string) => void = console.warn) {
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (event) => this.route(event),
      onError: (error) => this.orphanAll(`Child process worker failed: ${error.message}`),
      onExit: (code) => this.orphanAll(`Child process worker exited with code ${code}`),
      isIdle: () => this.children.size === 0,
      onUnavailable: (error) =>
        log(
          `[worker-thread-child-process] worker unavailable. ${error instanceof Error ? error.message : String(error)}`
        )
    })
  }

  spawn(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
    const id = this.nextId++
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request))
    const worker = this.host.ensure()
    if (!worker) {
      this.failToStart(child, 'Child process worker is unavailable')
      return child
    }
    this.host.clearIdleTimer()
    this.children.set(id, child)
    try {
      worker.postMessage({
        type: 'spawn',
        id,
        spec
      } satisfies WorkerThreadChildRequest)
    } catch (error) {
      this.children.delete(id)
      this.failToStart(child, error instanceof Error ? error.message : String(error))
    }
    return child
  }

  private post(request: WorkerThreadChildRequest): void {
    try {
      this.host.current?.postMessage(request)
    } catch {
      // A dead worker reports through onExit/onError, which orphans this child.
    }
  }

  private route(event: WorkerThreadChildEvent): void {
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    if (event.type === 'close') {
      this.children.delete(event.id)
      if (this.children.size === 0) {
        this.host.scheduleIdleTeardown()
      }
    }
    child.receive(event)
  }

  private failToStart(child: WorkerThreadChildProcess, message: string): void {
    // Deferred like Node's own spawn errors, so the caller can attach listeners first.
    process.nextTick(() => {
      const exit = {
        id: child.id,
        code: WORKER_THREAD_CHILD_SPAWN_FAILED_EXIT_CODE,
        signal: null
      }
      child.receive({ type: 'error', id: child.id, error: { message } })
      child.receive({ type: 'exit', ...exit })
      child.receive({ type: 'close', ...exit })
    })
  }

  private orphanAll(message: string): void {
    const orphans = [...this.children.values()]
    this.children.clear()
    this.host.destroy()
    for (const child of orphans) {
      child.orphan({ message })
    }
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // Why: throw synchronously so spawn() fails closed instead of waiting on a worker that never loads.
  if (!existsSync(workerPath)) {
    throw new Error(`Child process worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedHost: WorkerThreadChildProcessHost | null = null

/**
 * Spawn a piped child from the shared worker thread so process creation never
 * blocks the main event loop.
 * @param spec - Program, argv, cwd and env; stdio is always three pipes.
 * @returns A ChildProcess-shaped proxy whose events arrive from the worker.
 */
export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost.spawn(spec)
}
