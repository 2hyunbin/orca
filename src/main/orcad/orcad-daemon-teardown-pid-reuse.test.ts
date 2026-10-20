import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import {
  __setDaemonProcessTableReaderForTests,
  killProfileDaemons
} from './orcad-daemon-teardown-fixture'

vi.mock('../daemon/daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))

const row = (
  pid: number,
  ppid: number,
  name: string,
  creationTimeMs: number
): WindowsProcessIdentityRow => ({ pid, ppid, name, creationTimeMs })

let userData: string
let daemonPid: number

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'orcad-teardown-pid-reuse-'))
  mkdirSync(join(userData, 'daemon'))
  // An exited process stands in for the daemon, so only its descendants are left to prove.
  const child = spawnProcess({ program: process.execPath, args: ['-e', ''], timeoutMs: null })
  await new Promise((resolve) => child.once('close', resolve))
  daemonPid = child.pid ?? 0
  expect(daemonPid).toBeGreaterThan(0)
  writeFileSync(join(userData, 'daemon', 'daemon-v1.pid'), JSON.stringify({ pid: daemonPid }))
})

afterEach(() => {
  __setDaemonProcessTableReaderForTests()
  vi.useRealTimers()
  rmSync(userData, { recursive: true, force: true })
})

describe('daemon teardown descendants', () => {
  it('ignores an older process that names the daemon’s reused pid as its parent', async () => {
    // A build's vctip.exe outlives its parent; the daemon later takes that parent's pid.
    __setDaemonProcessTableReaderForTests(async () => [
      row(daemonPid, 1, 'node.exe', 2_000),
      row(9_001, daemonPid, 'vctip.exe', 1_000)
    ])
    await expect(killProfileDaemons(userData)).resolves.toBeUndefined()
  })

  it('still waits for a real child that outlives the daemon', async () => {
    vi.useFakeTimers()
    __setDaemonProcessTableReaderForTests(async () => [
      row(daemonPid, 1, 'node.exe', 2_000),
      row(9_002, daemonPid, 'OpenConsole.exe', 3_000)
    ])
    const rejected = expect(killProfileDaemons(userData)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('OpenConsole.exe') })]
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
  })
})
