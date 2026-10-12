import type * as ChildProcessModule from 'node:child_process'
import type * as FsModule from 'node:fs'
import type * as ProcessHostModule from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

const PS_START = 'Thu Aug 13 12:34:56 2026'
const PS_STARTED_AT_MS = Date.parse(PS_START)

const { runProcessMock, runProcessSyncMock, execFileSyncMock, psCommandLine, psError } = vi.hoisted(
  () => ({
    runProcessMock: vi.fn(async (_spec: { program: string; args?: readonly string[] }) => {
      if (psError.value) {
        throw psError.value
      }
      return {
        code: 0,
        signal: null,
        stdout: `${PS_START} ${psCommandLine.value}
`,
        stderr: '',
        timedOut: false
      }
    }),
    runProcessSyncMock: vi.fn(),
    execFileSyncMock: vi.fn(() => ''),
    psCommandLine: { value: '' },
    psError: { value: null as Error | null }
  })
)

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHostModule>()),
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFileSync: execFileSyncMock
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return {
    ...actual,
    readFileSync: ((path, options) => {
      if (String(path) === `/proc/${process.pid}/cmdline`) {
        throw new Error('procfs unavailable on macOS')
      }
      return actual.readFileSync(path, options)
    }) as typeof actual.readFileSync
  }
})

function expectNoSynchronousSpawn(): void {
  expect(runProcessSyncMock).not.toHaveBeenCalled()
  expect(execFileSyncMock).not.toHaveBeenCalled()
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const { getMacDaemonTccAttributionHealth } = await import('./daemon-tcc-attribution')
const { isDaemonStaleForCurrentBundle } = await import('./daemon-bundle-staleness')

describe('macOS daemon TCC attribution main-thread cost', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let spawnerExecPath: string

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tcc-main-thread-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    spawnerExecPath = join(dir, 'Orca')
    writeFileSync(spawnerExecPath, '')
    psCommandLine.value = `node daemon-entry --socket ${socketPath} --token ${tokenPath}`
    psError.value = null
    runProcessMock.mockClear()
    runProcessSyncMock.mockClear()
    execFileSyncMock.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  afterAll(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function writePidRecord(appVersion?: string, includeSpawner = true): void {
    writeFileSync(
      join(dir, `daemon-v${PROTOCOL_VERSION}.pid`),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: PS_STARTED_AT_MS,
        launchNonce: 'launch-a',
        ...(appVersion === undefined ? {} : { appVersion }),
        ...(includeSpawner ? { spawnerExecPath } : {})
      })
    )
  }

  it('deduplicates bundle-staleness identity inspection and invalidates by generation', async () => {
    writePidRecord('1.2.2')

    await expect(
      Promise.all([
        isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3'),
        isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')
      ])
    ).resolves.toEqual([true, true])
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      true
    )
    expect(runProcessMock).toHaveBeenCalledTimes(1)

    writePidRecord('1.2.3')
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expectNoSynchronousSpawn()
  })

  it('retries an indeterminate bundle-staleness identity inspection', async () => {
    writePidRecord('1.2.2')
    psError.value = new Error('ps unavailable')
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      false
    )

    psError.value = null
    await expect(isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).resolves.toBe(
      true
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expectNoSynchronousSpawn()
  })

  it('deduplicates identity inspection by daemon generation without a synchronous spawn', async () => {
    writePidRecord('1.2.2')

    await expect(
      Promise.all([
        getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath),
        getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)
      ])
    ).resolves.toEqual(['intact', 'intact'])
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )

    expectNoSynchronousSpawn()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'ps',
        args: ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command=']
      })
    )

    writePidRecord('1.2.3')
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)

    rmSync(spawnerExecPath)
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'severed'
    )
    expect(runProcessMock).toHaveBeenCalledTimes(3)
  })

  it('retries an indeterminate identity inspection', async () => {
    writePidRecord('1.2.2')
    psError.value = new Error('ps unavailable')
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    psError.value = null
    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'intact'
    )

    expectNoSynchronousSpawn()
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('fails open for a legacy pid record without app-version metadata', async () => {
    writePidRecord(undefined, false)

    await expect(getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).resolves.toBe(
      'unknown'
    )

    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expectNoSynchronousSpawn()
  })
})
