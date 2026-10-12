import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowsProcessRow } from '../windows/windows-process-table'

const { readWindowsProcessTableFresh, readWindowsProcessCreationTime } = vi.hoisted(() => ({
  readWindowsProcessTableFresh: vi.fn<() => Promise<WindowsProcessRow[]>>(),
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>()
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTableFresh,
  readWindowsProcessCreationTime
}))

const { inspectDaemonProcessIdentity } = await import('./daemon-pid-identity')

const socketPath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\daemon\\daemon-v4.sock'
const tokenPath = 'C:\\Users\\me\\AppData\\Roaming\\orca\\daemon\\daemon-v4.token'
const daemonCommandLine = `"C:\\Orca\\Orca.exe" daemon-entry.js --socket ${socketPath} --token ${tokenPath}`
const STARTED_AT_MS = 1_700_000_000_000
// process.kill(pid, 0) must succeed, so the row under test is this process's own.
const pid = process.pid

function tableWith(row: Partial<WindowsProcessRow>): WindowsProcessRow[] {
  return [{ pid, ppid: 1, name: 'Orca.exe', command: daemonCommandLine, ...row }]
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('inspectDaemonProcessIdentity on Windows', () => {
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  beforeEach(() => {
    readWindowsProcessTableFresh.mockReset()
    readWindowsProcessCreationTime.mockReset().mockReturnValue(null)
  })

  it('matches the daemon command line within the bootstrap tolerance', async () => {
    readWindowsProcessTableFresh.mockResolvedValue(
      tableWith({ creationTimeMs: STARTED_AT_MS - 2_000 })
    )

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('match')
    expect(readWindowsProcessTableFresh).toHaveBeenCalledTimes(1)
  })

  it('rejects a reused PID whose creation time differs, even with a daemon command line', async () => {
    readWindowsProcessTableFresh.mockResolvedValue(
      tableWith({ creationTimeMs: STARTED_AT_MS + 60 * 60_000 })
    )

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('mismatch')
  })

  it('rejects a PID running a different command line', async () => {
    readWindowsProcessTableFresh.mockResolvedValue(
      tableWith({ command: 'C:\\Windows\\notepad.exe', creationTimeMs: STARTED_AT_MS })
    )

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('mismatch')
  })

  it('falls back to the single-PID creation time when the snapshot row has none', async () => {
    readWindowsProcessTableFresh.mockResolvedValue(tableWith({}))
    readWindowsProcessCreationTime.mockReturnValue(STARTED_AT_MS + 60 * 60_000)

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('mismatch')
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(pid)
  })

  it('fails open on start time when no creation time is available', async () => {
    readWindowsProcessTableFresh.mockResolvedValue(tableWith({}))

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('match')
  })

  it('reports unknown when the process table cannot be read', async () => {
    readWindowsProcessTableFresh.mockRejectedValue(new Error('windows process table unavailable'))

    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('unknown')
  })

  it('reports unknown when the command line was denied or the row is absent', async () => {
    readWindowsProcessTableFresh.mockResolvedValueOnce(
      tableWith({ command: '', creationTimeMs: STARTED_AT_MS })
    )
    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('unknown')

    readWindowsProcessTableFresh.mockResolvedValueOnce([])
    await expect(
      inspectDaemonProcessIdentity(pid, socketPath, tokenPath, STARTED_AT_MS)
    ).resolves.toBe('unknown')
  })
})
