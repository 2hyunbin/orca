import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

// Both halves joined by a real MessageChannel, so every event crosses structured
// clone exactly as it does between the main thread and the worker.
const openPorts: MessagePort[] = []

function makeConnectedHost(): WorkerThreadChildProcessHost {
  return new WorkerThreadChildProcessHost(() => {
    const { port1, port2 } = new MessageChannel()
    openPorts.push(port1, port2)
    serveWorkerThreadChildProcesses(port2)
    return {
      postMessage: (message: unknown) => port1.postMessage(message),
      on: (event: string | symbol, listener: (...args: unknown[]) => void) =>
        port1.on(String(event), listener),
      off: (event: string | symbol, listener: (...args: unknown[]) => void) =>
        port1.off(String(event), listener),
      removeAllListeners: () => port1.removeAllListeners(),
      unref: () => port1.unref(),
      terminate: async () => {
        port1.close()
        return 0
      }
    }
  })
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
})
