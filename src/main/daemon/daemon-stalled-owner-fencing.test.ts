import { TerminalHost } from './terminal-host'
import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonSessionInfo } from './types'
import { DaemonClient } from './client'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'

const probe = vi.hoisted(() => ({ check: vi.fn(), stalled: vi.fn() }))
vi.mock('./daemon-async-io-probe', () => ({
  checkDaemonAsyncIo: probe.check,
  isDaemonAsyncIoStalled: probe.stalled
}))
let directory: string
let server: DaemonServer
let client: DaemonClient
const shutdownRequested = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()
  probe.check.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  probe.stalled.mockReturnValue(true)
  directory = mkdtempSync(join(tmpdir(), 'owner-fence-'))
  server = new DaemonServer({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'daemon.token'),
    spawnSubprocess: () => createMockSubprocess(),
    onShutdownRequested: shutdownRequested
  })
  await server.start()
  client = new DaemonClient({
    socketPath: getDaemonSocketPath(directory),
    tokenPath: join(directory, 'daemon.token')
  })
  await client.ensureConnected()
  await client.request('createOrAttach', { sessionId: 'reviewed', cols: 80, rows: 24 })
})
afterEach(async () => {
  client?.disconnect()
  await server?.shutdown()
  rmSync(directory, { recursive: true, force: true })
})

async function reviewedRequest() {
  const identity = client.getDaemonIdentity()
  if (!identity || identity.startedAtMs === null || identity.launchNonce === null) {
    throw new Error('Missing test identity')
  }
  const inventory = await client.request<{ sessions: DaemonSessionInfo[] }>(
    'listSessions',
    undefined
  )
  return {
    owner: {
      protocolVersion: 50,
      pid: identity.pid,
      startedAtMs: identity.startedAtMs,
      launchNonce: identity.launchNonce
    },
    sessions: inventory.sessions.map((session) => {
      if (!session.incarnationId) {
        throw new Error('Missing test incarnation')
      }
      return {
        sessionId: session.sessionId,
        incarnationId: session.incarnationId,
        cwd: session.cwd,
        pid: session.pid
      }
    })
  }
}

it('refuses a new incarnation with the same reviewed session ID', async () => {
  const request = await reviewedRequest()
  request.sessions[0].incarnationId = 'previous-incarnation'
  expect(await client.request('shutdownStalledOwner', request)).toEqual({ status: 'refused' })
  expect(shutdownRequested).not.toHaveBeenCalled()
  expect((await reviewedRequest()).sessions).toHaveLength(1)
})

it('refuses a terminal added after review without fencing the owner', async () => {
  const request = await reviewedRequest()
  await client.request('createOrAttach', { sessionId: 'not-reviewed', cols: 80, rows: 24 })
  expect(await client.request('shutdownStalledOwner', request)).toEqual({ status: 'refused' })
  expect(shutdownRequested).not.toHaveBeenCalled()
  expect((await reviewedRequest()).sessions).toHaveLength(2)
})

it('refuses a recovered probe even when the awaited health response was stalled', async () => {
  const request = await reviewedRequest()
  probe.stalled.mockReturnValue(false)
  expect(await client.request('shutdownStalledOwner', request)).toEqual({ status: 'refused' })
  expect(shutdownRequested).not.toHaveBeenCalled()
})

it('refuses a stale daemon incarnation despite a matching process ID', async () => {
  const request = await reviewedRequest()
  request.owner.launchNonce = 'previous-launch'
  expect(await client.request('shutdownStalledOwner', request)).toEqual({ status: 'refused' })
  expect(shutdownRequested).not.toHaveBeenCalled()
})

it('shuts down exactly the reviewed live inventory through the real daemon RPC', async () => {
  const request = await reviewedRequest()
  expect(await client.request('shutdownStalledOwner', request)).toEqual({
    status: 'restarted',
    killedCount: 1
  })
  expect(shutdownRequested).toHaveBeenCalled()
})

it('does not acknowledge recovery when native session disposal fails after admission closes', async () => {
  const request = await reviewedRequest()
  const dispose = vi
    .spyOn(TerminalHost.prototype, 'dispose')
    .mockRejectedValueOnce(new Error('native disposal failed'))
  try {
    await expect(client.request('shutdownStalledOwner', request)).rejects.toThrow(
      'Terminal service disposal could not be verified'
    )
    expect(shutdownRequested).toHaveBeenCalled()
  } finally {
    dispose.mockRestore()
  }
})
