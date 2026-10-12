import { EventEmitter } from 'node:events'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

// Both halves joined by a real MessageChannel, so every event crosses structured
// clone exactly as it does between the main thread and the worker. The emitter
// in front of port1 lets a test fake the worker's death.
const openPorts: MessagePort[] = []
const workerDeaths: (() => void)[] = []

function makeConnectedHost(): WorkerThreadChildProcessHost {
  return new WorkerThreadChildProcessHost(() => {
    const { port1, port2 } = new MessageChannel()
    openPorts.push(port1, port2)
    serveWorkerThreadChildProcesses(port2)
    const transport = new EventEmitter()
    port1.on('message', (message) => transport.emit('message', message))
    workerDeaths.push(() => transport.emit('exit', 1))
    return Object.assign(transport, {
      postMessage: (message: unknown) => port1.postMessage(message),
      unref: () => port1.unref(),
      terminate: async () => {
        port1.close()
        return 0
      }
    })
  })
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} is still running`)
}

function waitForClose(child: WorkerThreadChildProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])))
}

const ECHO_SCRIPT = `
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line) => process.stdout.write('echo:' + line))
process.stdin.on('end', () => { process.stderr.write('bye'); process.exit(7) })
`

describe('serveWorkerThreadChildProcesses', () => {
  afterEach(() => {
    workerDeaths.length = 0
    for (const port of openPorts.splice(0)) {
      port.close()
    }
  })

  it('runs a real piped child across the message boundary', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', ECHO_SCRIPT]
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const closed = waitForClose(child)
    await new Promise((resolve) => child.once('spawn', resolve))
    expect(child.pid).toEqual(expect.any(Number))

    child.stdin.write('{"id":1}\n')
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.stdin.end()

    await expect(closed).resolves.toEqual([7, null])
    expect(stdout.join('')).toBe('echo:{"id":1}\n')
    expect(stderr.join('')).toBe('bye')
    expect(child.exitCode).toBe(7)
  }, 20_000)

  it('passes env and cwd through to the child', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.ORCA_PROBE_MARKER + "|" + process.cwd())'],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_PROBE_MARKER: 'marker' }
    })
    const stdout: string[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))

    await expect(waitForClose(child)).resolves.toEqual([0, null])
    expect(stdout.join('')).toBe(`marker|${process.cwd()}`)
  }, 20_000)

  it('reports a missing program as ENOENT so callers can say the CLI is not installed', async () => {
    const child = makeConnectedHost().spawn({
      program: 'orca-definitely-missing-program',
      args: []
    })
    const error = new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve))

    await expect(error).resolves.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  it('kills a running child on request', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    })
    await new Promise((resolve) => child.once('spawn', resolve))
    const closed = waitForClose(child)

    expect(child.kill()).toBe(true)

    const [code, signal] = await closed
    expect(code !== 0 || signal !== null).toBe(true)
  }, 20_000)

  it('kills the real process by pid when the worker dies under it', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    })
    await new Promise((resolve) => child.once('spawn', resolve))
    const pid = child.pid
    if (pid === undefined) {
      throw new Error('spawn reported no pid')
    }
    child.on('error', () => {})

    workerDeaths[0]()

    expect(child.kill()).toBe(true)
    await waitUntilGone(pid)
  }, 20_000)
})
