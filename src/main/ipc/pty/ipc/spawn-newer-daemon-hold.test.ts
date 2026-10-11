import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/newer-daemon-hold'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  runPtyIpcSpawn: vi.fn(async () => ({ id: 'spawned' })),
  hasHold: vi.fn(() => false),
  isHeld: vi.fn(async () => false)
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  })
}))
vi.mock('./spawn-run', () => ({ runPtyIpcSpawn: mocks.runPtyIpcSpawn }))
vi.mock('../../../daemon/daemon-newer-protocol-hold', () => ({
  hasNewerProtocolDaemonHold: mocks.hasHold,
  isSessionHeldByNewerDaemon: mocks.isHeld
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({ getDaemonProvider: () => null }))

import { installPtySpawnIpcHandler } from './spawn'
import type { PtySpawnIpcDeps } from './spawn-types'

function spawn(args: Record<string, unknown>): Promise<unknown> {
  const handler = mocks.handlers.get('pty:spawn')
  if (!handler) {
    throw new Error('pty:spawn not installed')
  }
  return handler({}, { cols: 80, rows: 24, ...args })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasHold.mockReturnValue(false)
  mocks.isHeld.mockResolvedValue(false)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only getLocalPtyStartupPromise before the mocked runPtyIpcSpawn.
  installPtySpawnIpcHandler({
    getLocalPtyStartupPromise: () => undefined
  } as unknown as PtySpawnIpcDeps)
})

describe('pty:spawn newer-daemon hold', () => {
  it('spawns normally when no newer daemon is held, without a census', async () => {
    await expect(spawn({ sessionId: 's1' })).resolves.toEqual({ id: 'spawned' })
    expect(mocks.isHeld).not.toHaveBeenCalled()
  })

  it('refuses a held restore before anything spawns', async () => {
    mocks.hasHold.mockReturnValue(true)
    mocks.isHeld.mockResolvedValue(true)
    await expect(spawn({ sessionId: 's1' })).rejects.toThrow(NEWER_DAEMON_HOLD_ERROR)
    expect(mocks.runPtyIpcSpawn).not.toHaveBeenCalled()
  })

  it('spawns a restore an adopted daemon owns', async () => {
    mocks.hasHold.mockReturnValue(true)
    await expect(spawn({ sessionId: 's1' })).resolves.toEqual({ id: 'spawned' })
    expect(mocks.isHeld).toHaveBeenCalledWith('s1', null)
  })

  it('never holds a fresh terminal or another host terminal', async () => {
    mocks.hasHold.mockReturnValue(true)
    mocks.isHeld.mockResolvedValue(true)
    await expect(spawn({})).resolves.toEqual({ id: 'spawned' })
    await expect(spawn({ sessionId: 's1', connectionId: 'ssh-1' })).resolves.toEqual({
      id: 'spawned'
    })
    expect(mocks.isHeld).not.toHaveBeenCalled()
  })
})
