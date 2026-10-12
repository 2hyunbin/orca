// Messages between a main-thread child proxy and the worker that owns the real
// child. Kept free of Electron, node:worker_threads and node:child_process so
// either side can import it without dragging the other's dependencies across.

/** Structured-clone-safe subset of ProcessSpec; stdio is always three pipes. */
export type WorkerThreadChildSpec = {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export type WorkerThreadChildRequest =
  | { type: 'spawn'; id: number; spec: WorkerThreadChildSpec }
  | { type: 'stdin-write'; id: number; data: string }
  | { type: 'stdin-end'; id: number }
  | { type: 'kill'; id: number; signal?: NodeJS.Signals }

export type WorkerThreadChildErrorPayload = { message: string; code?: string }

export type WorkerThreadChildEvent =
  | { type: 'spawn'; id: number; pid: number | undefined }
  // Structured clone turns a Buffer into a plain Uint8Array.
  | { type: 'stdout' | 'stderr'; id: number; chunk: Uint8Array }
  | {
      type: 'error' | 'stdin-error'
      id: number
      error: WorkerThreadChildErrorPayload
    }
  | {
      type: 'exit' | 'close'
      id: number
      code: number | null
      signal: NodeJS.Signals | null
    }

/** Exit code reported when process creation itself threw, mirroring Node's negative errno. */
export const WORKER_THREAD_CHILD_SPAWN_FAILED_EXIT_CODE = -1
