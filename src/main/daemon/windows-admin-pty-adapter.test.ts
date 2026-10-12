import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { WindowsAdminPtyAdapter } from './windows-admin-pty-adapter'
import { WindowsAdminApprovalCanceledError } from './windows-admin-daemon-launch'
import { getDaemonPidPath, getDaemonTokenPath } from './daemon-spawner'

const mocks = vi.hoisted(() => ({
  connected: false,
  launch: vi.fn(),
  connect: vi.fn(),
  spawn: vi.fn(),
  listProcesses: vi.fn()
}))

vi.mock('./daemon-launch-paths', () => ({ getDaemonHistoryDir: () => '/history' }))
vi.mock('./daemon-out-of-process-launcher', () => ({
  createOutOfProcessLauncher: () => mocks.launch
}))
vi.mock('./daemon-endpoint-adoption', () => ({ releaseDaemonAdoptionLease: vi.fn() }))
vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class {
    client = { isConnected: () => mocks.connected }
    tokenPath: string
    pidPath: string | null
    lastAuthenticatedIdentity = null
    spawn(options: PtySpawnOptions) {
      return mocks.spawn(options)
    }
    listProcesses() {
      return mocks.listProcesses()
    }
    constructor(options: DaemonPtyAdapterOptions) {
      this.tokenPath = options.tokenPath
      this.pidPath = options.pidPath ?? null
    }
    async establishLifecycleLease() {
      await mocks.connect()
      mocks.connected = true
    }
  }
}))

beforeEach(() => {
  mocks.connected = false
  mocks.launch.mockReset().mockResolvedValue({ shutdown: async () => {} })
  mocks.connect.mockReset().mockResolvedValue(undefined)
  mocks.spawn.mockReset().mockResolvedValue({ id: 'terminal' })
  mocks.listProcesses.mockReset()
})

it('coalesces starts and keeps subsequent terminals out of the respawn throttle', async () => {
  const adapter = new WindowsAdminPtyAdapter('/unused-admin-runtime')
  const options = { cols: 80, rows: 24 }
  await Promise.all([adapter.spawn(options), adapter.spawn(options)])
  for (let index = 0; index < 6; index++) {
    await adapter.spawn(options)
  }
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.spawn).toHaveBeenCalledTimes(8)
})

it.each(['automatic-restore', 'automation'] as const)(
  '%s can use an approved host but cannot display consent',
  async (spawnIntent) => {
    const adapter = new WindowsAdminPtyAdapter('/unused-admin-runtime')
    mocks.connect.mockRejectedValueOnce(new Error('Host unavailable'))
    await expect(adapter.spawn({ cols: 80, rows: 24, spawnIntent })).rejects.toThrow(
      'Open a new PowerShell terminal'
    )
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    await adapter.spawn({ cols: 80, rows: 24, spawnIntent })
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)

it('lets an explicit retry request consent after a canceled launch', async () => {
  const adapter = new WindowsAdminPtyAdapter('/unused-admin-runtime')
  mocks.launch.mockRejectedValueOnce(new Error('Administrator terminal canceled'))
  await expect(adapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow('canceled')
  expect(mocks.spawn).not.toHaveBeenCalled()
  await adapter.spawn({ cols: 80, rows: 24 })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(mocks.spawn).toHaveBeenCalledOnce()
})

it('keeps declined approvals out of the crash-loop window', async () => {
  const adapter = new WindowsAdminPtyAdapter('/unused-admin-runtime')
  for (let index = 0; index < 6; index++) {
    mocks.launch.mockRejectedValueOnce(new WindowsAdminApprovalCanceledError())
    await expect(adapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow('canceled')
  }
  await adapter.spawn({ cols: 80, rows: 24 })
  expect(mocks.spawn).toHaveBeenCalledOnce()
})

it('reports an empty inventory only when the dead host is proven gone', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'orca-admin-'))
  const adapter = new WindowsAdminPtyAdapter(runtimeDir)
  const gone = Object.assign(new Error('connect ENOENT'), { syscall: 'connect', code: 'ENOENT' })
  mocks.listProcesses.mockRejectedValue(gone)
  const pidPath = getDaemonPidPath(runtimeDir)
  writeFileSync(getDaemonTokenPath(runtimeDir), 'token')
  writeFileSync(pidPath, JSON.stringify({ pid: process.pid }))
  await expect(adapter.listProcesses()).rejects.toBe(gone)
  writeFileSync(pidPath, JSON.stringify({ pid: 2_147_483_646 }))
  await expect(adapter.listProcesses()).resolves.toEqual([])
  expect([pidPath, getDaemonTokenPath(runtimeDir)].some((path) => existsSync(path))).toBe(false)
})
