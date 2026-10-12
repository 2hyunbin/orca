import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  WORKER_THREAD_CHILD_SPAWN_FAILED_EXIT_CODE,
  type WorkerThreadChildErrorPayload,
  type WorkerThreadChildEvent,
  type WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

// Worker-thread half: owns the real children so CreateProcessW blocks this
// thread, not the Electron main loop. Must stay electron-free.

export type WorkerThreadChildPort = {
  on(event: 'message', listener: (request: WorkerThreadChildRequest) => void): unknown
  postMessage(event: WorkerThreadChildEvent): void
}

function toErrorPayload(error: unknown): WorkerThreadChildErrorPayload {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string'
      ? { message: error.message, code: error.code }
      : { message: error.message }
  }
  return { message: String(error) }
}

export function serveWorkerThreadChildProcesses(port: WorkerThreadChildPort): void {
  const children = new Map<number, PipedChildProcess>()

  const spawnChild = ({ id, spec }: Extract<WorkerThreadChildRequest, { type: 'spawn' }>): void => {
    let child: PipedChildProcess
    try {
      child = spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      port.postMessage({ type: 'error', id, error: toErrorPayload(error) })
      const exit = {
        id,
        code: WORKER_THREAD_CHILD_SPAWN_FAILED_EXIT_CODE,
        signal: null
      }
      port.postMessage({ type: 'exit', ...exit })
      port.postMessage({ type: 'close', ...exit })
      return
    }
    children.set(id, child)
    child.on('spawn', () => port.postMessage({ type: 'spawn', id, pid: child.pid }))
    // Copied so the clone carries only this chunk, not the whole backing allocation.
    child.stdout?.on('data', (chunk: Buffer) =>
      port.postMessage({ type: 'stdout', id, chunk: new Uint8Array(chunk) })
    )
    child.stderr?.on('data', (chunk: Buffer) =>
      port.postMessage({ type: 'stderr', id, chunk: new Uint8Array(chunk) })
    )
    // An unhandled stream error would take the whole worker, and every other child, down.
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.stdin?.on('error', (error) =>
      port.postMessage({
        type: 'stdin-error',
        id,
        error: toErrorPayload(error)
      })
    )
    child.on('error', (error) =>
      port.postMessage({ type: 'error', id, error: toErrorPayload(error) })
    )
    child.on('exit', (code, signal) => port.postMessage({ type: 'exit', id, code, signal }))
    child.on('close', (code, signal) => {
      children.delete(id)
      port.postMessage({ type: 'close', id, code, signal })
    })
  }

  port.on('message', (request) => {
    if (request.type === 'spawn') {
      spawnChild(request)
      return
    }
    const child = children.get(request.id)
    if (!child) {
      return
    }
    try {
      if (request.type === 'stdin-write') {
        child.stdin?.write(request.data)
      } else if (request.type === 'stdin-end') {
        child.stdin?.end()
      } else {
        child.kill(request.signal)
      }
    } catch {
      // Races with exit; the exit/close events still reach the proxy.
    }
  })
}
