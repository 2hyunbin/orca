import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { captureElectronBrowserTransportShutdown } from './electron-browser-transport-shutdown'

function browserFixture(proc = new ChildProcess()) {
  if (proc.pid === undefined) {
    Object.defineProperty(proc, 'exitCode', { value: 0, writable: true })
  }
  const socket = {
    readyState: 1,
    calls: 0,
    terminate() {
      this.calls++
    }
  }
  const callbacks = new Map<number, unknown>()
  const browser = {
    options: { browserProcess: { process: proc } },
    _connection: {
      _closed: false,
      _sessions: new Map([['', { _callbacks: callbacks }]]),
      _transport: { _ws: socket }
    }
  }
  const implementation = {
    _process: proc,
    _nodeConnection: { _closed: true },
    _browserContext: { _browser: browser }
  }
  const app = { _connection: { toImpl: () => implementation } }
  return { app, proc, browser, implementation, socket, callbacks }
}

export function registerElectronBrowserTransportShutdownTests(): void {
  describe('owned Electron browser transport after process exit', () => {
    const blocked = [
      [
        'live Electron',
        (f: ReturnType<typeof browserFixture>) =>
          Object.defineProperty(f.proc, 'exitCode', { value: null })
      ],
      [
        'live Node inspector',
        (f: ReturnType<typeof browserFixture>) => (f.implementation._nodeConnection._closed = false)
      ],
      [
        'foreign application',
        (f: ReturnType<typeof browserFixture>) => (f.implementation._process = new ChildProcess())
      ],
      [
        'foreign browser',
        (f: ReturnType<typeof browserFixture>) =>
          (f.browser.options.browserProcess.process = new ChildProcess())
      ],
      [
        'pending protocol command',
        (f: ReturnType<typeof browserFixture>) => f.callbacks.set(1, {})
      ],
      [
        'unavailable root session',
        (f: ReturnType<typeof browserFixture>) => f.browser._connection._sessions.clear()
      ],
      [
        'already closed connection',
        (f: ReturnType<typeof browserFixture>) => (f.browser._connection._closed = true)
      ],
      ['already closed socket', (f: ReturnType<typeof browserFixture>) => (f.socket.readyState = 3)]
    ] as const
    it.each(blocked)('preserves the transport for %s', (_name, mutate) => {
      const fixture = browserFixture()
      const release = captureElectronBrowserTransportShutdown(fixture.app, fixture.proc, 'linux')
      mutate(fixture)
      expect(release()).toBe(false)
      expect(fixture.socket.calls).toBe(0)
    })

    it('keeps other platforms and unavailable SDK shapes on the original fallback', () => {
      const fixture = browserFixture()
      for (const platform of ['darwin', 'win32'] as const) {
        expect(captureElectronBrowserTransportShutdown(fixture.app, fixture.proc, platform)()).toBe(
          false
        )
      }
      expect(captureElectronBrowserTransportShutdown({}, fixture.proc, 'linux')()).toBe(false)
      expect(fixture.socket.calls).toBe(0)
    })

    it('closes a real socket only after the owned child exits', async () => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      let socket: WebSocket | undefined
      let child: ReturnType<typeof spawnProcess> | undefined
      try {
        await once(server, 'listening')
        const address = server.address()
        if (typeof address !== 'object' || address === null) {
          throw new Error('Missing owned WebSocket listener')
        }
        socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
        child = spawnProcess({
          program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
          args: ['-e', "process.stdout.write('ready'); process.stdin.resume()"],
          timeoutMs: null
        })
        if (!child.stdout) {
          throw new Error('Missing owned child readiness pipe')
        }
        await Promise.all([once(socket, 'open'), once(child.stdout, 'data')])
        const fixture = browserFixture(child)
        const transport = fixture.browser._connection._transport
        Object.defineProperty(transport, '_ws', { value: socket })
        const release = captureElectronBrowserTransportShutdown(fixture.app, child, 'linux')
        expect(release()).toBe(false)
        expect(socket.readyState).toBe(WebSocket.OPEN)
        const exited = once(child, 'close')
        child.kill('SIGTERM')
        await exited
        const closed = once(socket, 'close')
        expect(release()).toBe(true)
        await closed
        expect(socket.readyState).toBe(WebSocket.CLOSED)
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close')
          child.kill('SIGKILL')
          await closed
        }
        socket?.terminate()
        for (const client of server.clients) {
          client.terminate()
        }
        if (server.address()) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
        }
      }
    })
  })
}
