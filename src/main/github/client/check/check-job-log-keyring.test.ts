import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { createCheckDetailsAdmissionLifetime } from './check-details-admission-lifetime'
import { prCheckLogTailCache } from './check-job-log-tails'

const { spawnMock, signalMock, forceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
const children: ChildProcess[] = []
let token = 'keyring-A'
const options = { cwd: '/folder', env: {} }
const apiCalls = () => spawnMock.mock.calls.filter((call) => call[1][0] === 'api')
const authCalls = () => spawnMock.mock.calls.filter((call) => call[1][0] === 'auth')

describe('keyring credentials pinned to each log batch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    token = 'keyring-A'
    children.length = 0
    prCheckLogTailCache.clear()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    spawnMock
      .mockReset()
      .mockImplementation((_program, argv: string[], spawnOptions: SpawnOptions) => {
        const child = createFakeSpawnedChild(children.length + 900)
        children.push(child)
        const stdout =
          argv[0] === 'auth'
            ? token
            : `Error: ${spawnOptions.env?.GH_TOKEN ?? spawnOptions.env?.GH_ENTERPRISE_TOKEN}`
        queueMicrotask(() => completeFakeSpawn(child, { stdout }))
        return child
      })
  })
  afterEach(async () => {
    for (const child of children) {
      child.emit('close', 0, null)
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([1, 5])(
    'downloads %s jobs once, warms without downloads, and shares concurrent batches',
    async (count) => {
      const jobs = () => Array.from({ length: count }, (_, i) => failedLogJob(i + 1))
      for (let visit = 0; visit < 10; visit++) {
        await attachLogFixture(jobs(), { options })
      }
      expect(apiCalls()).toHaveLength(count)
      expect(authCalls()).toHaveLength(10)
      prCheckLogTailCache.clear()
      await Promise.all([
        attachLogFixture(jobs(), { options }),
        attachLogFixture(jobs(), { options })
      ])
      expect(apiCalls()).toHaveLength(count * 2)
      expect(authCalls()).toHaveLength(12)
      expect(prCheckLogTailCache.size).toBe(count)
    }
  )

  it.each(['github.com', 'code.acme.test'])(
    'isolates changed credentials and pins the downloaded token for %s',
    async (host) => {
      const repo = { owner: 'acme', repo: 'widgets', host }
      const first = [failedLogJob()]
      await attachLogFixture(first, { options, repo })
      token = 'keyring-B'
      const second = [failedLogJob()]
      await attachLogFixture(second, { options, repo })
      expect(first[0].logTail).toBe('Error: keyring-A')
      expect(second[0].logTail).toBe('Error: keyring-B')
      expect(apiCalls()).toHaveLength(2)
      token = 'keyring-A'
      await attachLogFixture([failedLogJob()], { options, repo })
      expect(apiCalls()).toHaveLength(2)
      expect(authCalls()[0][1]).toEqual(['auth', 'token', '--hostname', host])
      expect(JSON.stringify([...prCheckLogTailCache.keys()])).not.toContain('keyring-')
    }
  )

  it('keeps the resolved token when the active login changes before download', async () => {
    spawnMock.mockImplementation((_program, argv: string[], spawnOptions: SpawnOptions) => {
      const child = createFakeSpawnedChild()
      const stdout = argv[0] === 'auth' ? token : `Error: ${spawnOptions.env?.GH_TOKEN}`
      if (argv[0] === 'auth') {
        token = 'keyring-B'
      }
      queueMicrotask(() => completeFakeSpawn(child, { stdout }))
      return child
    })
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs, { options })
    expect(jobs[0].logTail).toBe('Error: keyring-A')
    await attachLogFixture(jobs, { options })
    expect(jobs[0].logTail).toBe('Error: keyring-B')
    expect(apiCalls()).toHaveLength(2)
  })

  it.each(['', 'wrapper banner\nkeyring-A'])(
    'keeps unavailable or malformed credentials uncached %#',
    async (value) => {
      token = value
      await attachLogFixture([failedLogJob()], { options })
      await attachLogFixture([failedLogJob()], { options })
      expect(apiCalls()).toHaveLength(2)
      expect(authCalls()).toHaveLength(2)
      expect(prCheckLogTailCache.size).toBe(0)
    }
  )

  it('does not resolve credentials for passing checks or already pinned tokens', async () => {
    await attachLogFixture([failedLogJob(77, { conclusion: 'success' })], { options })
    expect(spawnMock).not.toHaveBeenCalled()
    await attachLogFixture([failedLogJob()])
    expect(authCalls()).toHaveLength(0)
    expect(apiCalls()).toHaveLength(1)
  })

  it.each(['darwin', 'linux', 'win32'])(
    'reuses logs on a native %s execution host',
    async (platform) => {
      const original = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      try {
        const nativeOptions = { cwd: platform === 'win32' ? 'C:\\folder' : '/folder', env: {} }
        await attachLogFixture([failedLogJob()], { options: nativeOptions })
        await attachLogFixture([failedLogJob()], { options: nativeOptions })
        expect(authCalls()).toHaveLength(2)
        expect(apiCalls()).toHaveLength(1)
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: original })
      }
    }
  )

  it('falls back without caching when the keyring read fails', async () => {
    spawnMock.mockImplementation((_program, argv: string[]) => {
      const child = createFakeSpawnedChild()
      queueMicrotask(() =>
        completeFakeSpawn(
          child,
          argv[0] === 'auth'
            ? { code: 1, stderr: 'keyring unavailable' }
            : { stdout: 'Error: uncached log' }
        )
      )
      return child
    })
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs, { options })
    await attachLogFixture(jobs, { options })
    expect(jobs[0].logTail).toBe('Error: uncached log')
    expect(apiCalls()).toHaveLength(2)
    expect(prCheckLogTailCache.size).toBe(0)
  })

  it('holds admission until a canceled keyring child closes and starts no logs', async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeSpawnedChild(999)
      child.kill = vi.fn(() => false)
      children.push(child)
      return child
    })
    const controller = new AbortController()
    const release = vi.fn()
    const gate = createCheckDetailsAdmissionLifetime(release)
    const pending = attachLogFixture([failedLogJob()], {
      options,
      controller,
      retainUntil: gate.retainUntil
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('private caller reason'))
    await rejection
    gate.finish()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(release).not.toHaveBeenCalled()
    completeFakeSpawn(children[0], { stdout: 'late-secret' })
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(apiCalls()).toHaveLength(0)
    expect(prCheckLogTailCache.size).toBe(0)
  })

  it('starts no credential lookup when the deadline expires before its deferred spawn', async () => {
    const deadlineAt = Date.now() + 1
    const pending = attachLogFixture([failedLogJob()], { options, deadlineAt })
    vi.setSystemTime(deadlineAt)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
