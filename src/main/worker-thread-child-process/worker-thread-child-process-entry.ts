import { parentPort } from 'node:worker_threads'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

// Why: libuv runs uv_spawn inline on the calling loop, so a slow CreateProcessW
// (code-integrity hashing a large uncached binary, #27362) stalls only this thread.

if (!parentPort) {
  throw new Error('Worker-thread child process host must run with a parent port.')
}
serveWorkerThreadChildProcesses(parentPort)
