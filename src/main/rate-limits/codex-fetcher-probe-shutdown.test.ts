import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type * as ChildProcessModule from 'node:child_process'
import type * as ProcessHostModule from '@orca/process-host'
import type * as ProviderLedgerModule from '../provider-process/provider-process-ledger'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { readPosixProcessRow } from '../provider-process/provider-process-row-read'
import { recordProviderLaunch } from '../provider-process/provider-process-ledger'
import * as files from 'node:fs/promises'
import * as backend from './codex-backend-usage-client'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

// The probe's child runs in-process here; the worker transport has its own suite.
vi.mock(
  '../worker-thread-child-process/worker-thread-child-process',
  () =>
    import('../worker-thread-child-process/worker-thread-child-process-in-process.test-fixtures')
)
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: childSpawnMock
}))

// The recovery's supervised stop imports the process-table reader, which needs the real execFile.
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof files>()),
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

// Auth gate is covered by codex-auth-presence.test.ts; these tests assume a signed-in Codex.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { probeCodexAuthPresence } from './codex-auth-presence'

function makeRpcChild() {
  type RpcChild = EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
  }
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  const kill = vi.fn(() => {
    exitNow()
    return true
  })
  const child: RpcChild = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    kill,
    exitCode: null
  })
  child.once('exit', (code, signal) => child.emit('close', code, signal))
  return child
}

function respondToRpcRateLimitRead(
  rpcChild: ReturnType<typeof makeRpcChild>,
  rateLimits: unknown
): void {
  rpcChild.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.method === 'initialize') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        )
      }, 0)
    }
    if (msg.method === 'account/rateLimits/read') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { rateLimits } })}\n`)
        )
      }, 0)
    }
  })
}

describe('fetchCodexRateLimits probe shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('present')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -9_999_999) {
        throw new Error(`Unexpected fixture signal: ${pid}`)
      }
      const child = childSpawnMock.mock.results.at(-1)?.value
      if (!child || child.exitCode !== null) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
      if (signal !== 0) {
        child.kill(signal)
      }
      return true
    })
    vi.mocked(readPosixProcessRow).mockImplementation(async () => {
      const child = childSpawnMock.mock.results.at(-1)?.value
      return child?.exitCode === null
        ? {
            pid: 9_999_999,
            pgid: 9_999_999,
            ppid: process.pid,
            startedAt: 'fixture-start',
            startResolution: 'clock-tick'
          }
        : null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([false, true])(
    'reports unavailable verification with backend fallback=%s',
    async (succeeds) => {
      const saved = getAppEnvironment()
      setAppEnvironment({
        ...saved,
        getPath: (key) =>
          key === 'userData'
            ? join(saved.getPath(key), `unavailable-${succeeds}`)
            : saved.getPath(key)
      })
      const inventory = vi
        .spyOn(files, 'readdir')
        .mockRejectedValue(Object.assign(new Error('inventory denied'), { code: 'EACCES' }))
      const fallback = {
        provider: 'codex',
        status: 'ok',
        session: null,
        weekly: null,
        error: null,
        updatedAt: Date.now()
      } as const
      vi.spyOn(backend, 'fetchCodexRateLimitsViaBackend').mockResolvedValue(
        succeeds ? fallback : null
      )
      try {
        const result = await fetchCodexRateLimits()
        expect(result).toMatchObject(
          succeeds
            ? fallback
            : {
                status: 'error',
                error: 'Orca could not verify previous Codex processes. Try again.'
              }
        )
        expect(childSpawnMock).not.toHaveBeenCalled()
      } finally {
        inventory.mockRestore()
        setAppEnvironment(saved)
      }
    }
  )

  it('gives a cold app-server the full boot budget before any deadline fires', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        // Why: cold starts (auth refresh included) are documented at 10-25s;
        // the old 10s deadline killed them mid-auth.
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 20_000)
      }
      if (msg.method === 'account/rateLimits/read') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  rateLimits: { primary: { usedPercent: 3 }, secondary: { usedPercent: 4 } }
                }
              })}\n`
            )
          )
        }, 0)
      }
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.waitFor(() => expect(childSpawnMock).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(19_999)
    expect(rpcChild.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    await expect(resultPromise).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 3 },
      weekly: { usedPercent: 4 }
    })
  })

  it('arms the read deadline after initialize and drains SIGTERM before SIGKILL', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const rpcChild = makeRpcChild()
    // Stubborn child: it ignores stdin EOF, survives SIGTERM, dies on SIGKILL.
    rpcChild.stdin.end = vi.fn()
    rpcChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        rpcChild.exitCode = 0
        rpcChild.emit('exit', 0, null)
      }
      return true
    })
    childSpawnMock.mockReturnValue(rpcChild)
    rpcChild.stdin.write.mockImplementation((line: string) => {
      const msg = JSON.parse(line) as { id?: number; method?: string }
      if (msg.method === 'initialize') {
        setTimeout(() => {
          rpcChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          )
        }, 0)
      }
      // The rate-limits read never answers, so the request deadline expires.
    })

    try {
      const resultPromise = fetchCodexRateLimits()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(rpcChild.kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(rpcChild.stdin.end).toHaveBeenCalledTimes(1)
      expect(rpcChild.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(rpcChild.kill).toHaveBeenCalledWith('SIGTERM')
      expect(rpcChild.kill).not.toHaveBeenCalledWith('SIGKILL')

      await vi.advanceTimersByTimeAsync(3_000)
      expect(rpcChild.kill).toHaveBeenCalledWith('SIGKILL')
      await expect(resultPromise).resolves.toMatchObject({
        status: 'error',
        error: 'RPC timeout'
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not spawn a second probe for the same home while one is still running', async () => {
    const firstChild = makeRpcChild()
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    const first = fetchCodexRateLimits({
      codexHomePath: '/managed/home-a'
    })
    await vi.advanceTimersByTimeAsync(0)
    const second = fetchCodexRateLimits({
      codexHomePath: '/managed/home-a'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(childSpawnMock).toHaveBeenCalledTimes(1)

    firstChild.exitCode = 0
    firstChild.emit('exit', 0, null)
    firstChild.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(childSpawnMock).toHaveBeenCalledTimes(2)
    await expect(second).resolves.toMatchObject({ status: 'ok' })
    await first
  })

  it('joins predecessor cleanup after early raw quota close while another home proceeds', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild(),
      nextChild = makeRpcChild(),
      otherChild = makeRpcChild()
    firstChild.pid = 9_999_991
    nextChild.pid = 9_999_992
    otherChild.pid = 9_999_993
    firstChild.stdin.end = vi.fn()
    const writer = { pid: 9_999_990, pgid: firstChild.pid, startedAt: 'captured-writer' }
    vi.mocked(recordProviderLaunch).mockReturnValueOnce({
      capture: async () => {},
      retire: async () => {},
      members: () => [writer]
    })
    let writerLive = true
    const gate = Promise.withResolvers<DescendantTreeVerdict>()
    const group = await import('../provider-process/provider-process-group')
    vi.spyOn(group, 'observeProviderGroup').mockImplementation(async (pid) =>
      pid === firstChild.pid ? gate.promise : 'exited'
    )
    vi.mocked(readPosixProcessRow).mockImplementation(async (pid) =>
      pid === writer.pid && writerLive
        ? { ...writer, ppid: 1, startResolution: 'clock-tick' }
        : null
    )
    childSpawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(otherChild)
      .mockReturnValueOnce(nextChild)
    respondToRpcRateLimitRead(otherChild, { primary: { usedPercent: 3 } })
    respondToRpcRateLimitRead(nextChild, { primary: { usedPercent: 4 } })
    try {
      const first = fetchCodexRateLimits({ codexHomePath: '/managed/early-close' })
      await vi.advanceTimersByTimeAsync(0)
      firstChild.exitCode = 1
      firstChild.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(0)
      await expect(first).resolves.toMatchObject({ status: 'error' })
      const same = fetchCodexRateLimits({ codexHomePath: '/managed/early-close' })
      const other = fetchCodexRateLimits({ codexHomePath: '/managed/early-close-other' })
      await vi.advanceTimersByTimeAsync(1)
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await expect(other).resolves.toMatchObject({ status: 'ok' })
      writerLive = false
      gate.resolve('exited')
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(same).resolves.toMatchObject({ status: 'ok' })
      expect(childSpawnMock).toHaveBeenCalledTimes(3)
    } finally {
      gate.resolve('exited')
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the home lock through child errors until the failed probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: '/managed/home-error'
      })
      await vi.advanceTimersByTimeAsync(0)
      firstChild.emit('error', new Error('stdio failed'))
      const second = fetchCodexRateLimits({
        codexHomePath: '/managed/home-error'
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(firstChild.stdin.end).toHaveBeenCalledOnce()
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'stdio failed' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it.each([
    { failAt: 1, phase: 'initial request' },
    { failAt: 2, phase: 'initialized notification' },
    { failAt: 3, phase: 'rate-limit request' }
  ])('keeps the home lock when the $phase stdin write throws', async ({ failAt, phase }) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    let writeCount = 0
    firstChild.stdin.write.mockImplementation((line: string) => {
      writeCount += 1
      if (writeCount === failAt) {
        throw new Error(`${phase} stdin failed`)
      }
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === 'initialize') {
        setTimeout(() => {
          firstChild.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
          )
        }, 0)
      }
    })
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })
    const home = `/managed/home-stdin-error-${failAt}`

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: home
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(firstChild.stdin.end).toHaveBeenCalledOnce()

      const second = fetchCodexRateLimits({
        codexHomePath: home
      })
      await vi.advanceTimersByTimeAsync(3_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({
        status: 'error',
        error: `${phase} stdin failed`
      })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('observes asynchronous stdin failures and keeps the lock until the probe exits', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const firstChild = makeRpcChild()
    firstChild.stdin.end = vi.fn()
    firstChild.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        firstChild.exitCode = 1
        firstChild.emit('exit', 1, 'SIGKILL')
      }
      return true
    })
    const secondChild = makeRpcChild()
    childSpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    respondToRpcRateLimitRead(secondChild, {
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 4 }
    })

    try {
      const first = fetchCodexRateLimits({
        codexHomePath: '/managed/home-async-stdin-error'
      })
      await vi.advanceTimersByTimeAsync(0)
      firstChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      const second = fetchCodexRateLimits({
        codexHomePath: '/managed/home-async-stdin-error'
      })

      await vi.advanceTimersByTimeAsync(3_999)
      expect(childSpawnMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      await vi.advanceTimersByTimeAsync(1)
      expect(childSpawnMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await expect(first).resolves.toMatchObject({ status: 'error', error: 'write EPIPE' })
      await expect(second).resolves.toMatchObject({ status: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})

vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHostModule>()),
  spawnProcess: (spec: ProcessSpec) => childSpawnMock(spec.program, spec.args ?? [], spec)
}))

vi.mock('../provider-process/provider-process-ledger', async (original) => ({
  ...(await original<typeof ProviderLedgerModule>()),
  recordProviderLaunch: vi.fn(() => ({
    capture: async () => {},
    retire: async () => {},
    members: () => [{ pid: 9_999_999, pgid: 9_999_999, startedAt: 'fixture-start' }]
  }))
}))

vi.mock('../provider-process/provider-process-row-read', () => ({ readPosixProcessRow: vi.fn() }))

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
