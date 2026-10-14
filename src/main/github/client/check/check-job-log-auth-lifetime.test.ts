import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { createCheckDetailsAdmissionLifetime } from './check-details-admission-lifetime'
import { prCheckLogTailCache } from './check-job-log-tails'
import { clearGhAccountTokenCacheForTests } from '../../gh-account-token'
import { clearGhCapabilityStateForTests } from '../../gh-capability-state'
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
describe('shared log auth prerequisite retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    clearGhAccountTokenCacheForTests()
    clearGhCapabilityStateForTests()
    prCheckLogTailCache.clear()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
    spawnMock.mockReset().mockImplementation(() => {
      const child = createFakeSpawnedChild(children.length + 700)
      child.kill = vi.fn(() => false)
      children.push(child)
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
  it('keeps the creator permit through signal-less help to token after every reader departs', async () => {
    const options = {
      cwd: '/folder',
      host: 'github.com',
      ghAccount: { host: 'github.com', user: 'Alice' },
      env: {}
    }
    const creator = new AbortController(),
      follower = new AbortController()
    const release = vi.fn(),
      gate = createCheckDetailsAdmissionLifetime(release)
    const a = attachLogFixture([failedLogJob()], {
      options,
      controller: creator,
      retainUntil: gate.retainUntil
    }).catch(() => {})
    const b = attachLogFixture([failedLogJob()], { options, controller: follower }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    expect(spawnMock.mock.calls[0][1]).toEqual(['auth', 'token', '--help'])
    creator.abort()
    follower.abort()
    await Promise.all([a, b])
    gate.finish()
    expect(release).not.toHaveBeenCalled()
    completeFakeSpawn(children[0], { stdout: '--user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    expect(spawnMock.mock.calls[1][1]).toContain('Alice')
    children[1].emit('error', new Error('private token capture'))
    await vi.advanceTimersByTimeAsync(0)
    expect(release).not.toHaveBeenCalled()
    children[1].emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(0)
    expect(prCheckLogTailCache.size).toBe(0)
  })
})
