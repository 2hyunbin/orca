import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean; startedAfter?: number }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('../wsl', () => wslMocks)

import {
  _resetWslUncAccessGateForTests,
  guardWslUncPathAccess,
  noteWslDistroMayHaveStopped,
  WSL_UNC_RUNNING_LEASE_MS,
  WslDistroStoppedError
} from './wsl-unc-access-gate'
import {
  _resetWslBackgroundDistroGateForTests,
  deferUntilWslDistroRunning
} from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let running: string[] = ['Ubuntu']
const probe = vi.fn(async () => running)

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  running = ['Ubuntu']
  wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
    resolveRunningWslDistros(probe, options)
  )
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _resetWslUncAccessGateForTests()
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('guardWslUncPathAccess', () => {
  it('refuses a background touch of a stopped distro without touching the path', async () => {
    running = []
    const access = vi.fn(async () => 'read')
    await expect(guardWslUncPathAccess(UNC, access)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(access).not.toHaveBeenCalled()
  })

  it('lets a touch of a running distro through', async () => {
    await expect(guardWslUncPathAccess(UNC, async () => 'read')).resolves.toBe('read')
  })

  it('never probes WSL for a non-UNC path or off Windows', async () => {
    await expect(guardWslUncPathAccess('C:\\repo', async () => 'read')).resolves.toBe('read')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    await expect(guardWslUncPathAccess(UNC, async () => 'read')).resolves.toBe('read')
    expect(probe).not.toHaveBeenCalled()
  })

  it('shares one running read across a burst of touches within the lease', async () => {
    await Promise.all([1, 2, 3].map(() => guardWslUncPathAccess(UNC, async () => 'read')))
    await guardWslUncPathAccess(UNC, async () => 'read')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('without a stop signal, trusts a running read for a minute (about one wsl.exe a minute)', async () => {
    await guardWslUncPathAccess(UNC, async () => 'read')
    const now = performance.now()
    const clock = vi.spyOn(performance, 'now')
    for (const later of [10_000, 30_000, WSL_UNC_RUNNING_LEASE_MS - 1_000]) {
      clock.mockReturnValue(now + later)
      await guardWslUncPathAccess(UNC, async () => 'read')
    }
    expect(WSL_UNC_RUNNING_LEASE_MS).toBeGreaterThanOrEqual(60_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the lease expires', async () => {
    await guardWslUncPathAccess(UNC, async () => 'read')
    const now = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(now + WSL_UNC_RUNNING_LEASE_MS + 1)
    await guardWslUncPathAccess(UNC, async () => 'read')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not trust a running read that started before the distro may have stopped', async () => {
    await guardWslUncPathAccess(UNC, async () => 'read')
    // The terminate: the read above still says running, but a link into the distro just died.
    running = []
    noteWslDistroMayHaveStopped('ubuntu')
    const access = vi.fn(async () => 'read')
    await expect(guardWslUncPathAccess(UNC, access)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(access).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('refuses when the running list cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    probe.mockRejectedValueOnce(new Error('wsl.exe wedged'))
    await expect(guardWslUncPathAccess(UNC, async () => 'read')).rejects.toBeInstanceOf(
      WslDistroStoppedError
    )
  })

  it('a user act touches without asking and, on success, resumes work waiting for the distro', async () => {
    running = []
    const resumed = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'test', resumed)
    await expect(guardWslUncPathAccess(UNC, async () => 'read', { wake: true })).resolves.toBe(
      'read'
    )
    expect(probe).not.toHaveBeenCalled()
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('a failed user act resumes nothing', async () => {
    const resumed = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'test', resumed)
    await expect(
      guardWslUncPathAccess(
        UNC,
        async () => {
          throw new Error('EIO')
        },
        { wake: true }
      )
    ).rejects.toThrow('EIO')
    expect(resumed).not.toHaveBeenCalled()
  })
})
