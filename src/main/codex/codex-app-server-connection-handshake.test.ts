import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { openCodexAppServerConnection } from './codex-app-server-connection'

afterEach(() => {
  vi.useRealTimers()
})

describe('Codex app-server handshake', () => {
  it('waits with no deadline until the start that opened it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const child = createFakePipedChild(9_999_999)
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = vi.fn()
    let written = ''
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })
    child.stdin.on('finish', () => child.emit('exit', 0, null))
    const start = new AbortController()
    const opening = openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { signal: start.signal },
      () => child
    ).catch((error: unknown) => error)
    await vi.waitFor(() => expect(written).toContain('"method":"initialize"'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(child.stdin.writableEnded).toBe(false)

    start.abort(new Error('codex never finished starting'))

    expect(await opening).toMatchObject({ message: 'codex never finished starting' })
    expect(child.stdin.writableEnded).toBe(true)
  })
})
