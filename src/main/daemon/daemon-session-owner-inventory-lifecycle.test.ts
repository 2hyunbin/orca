import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/pty-provider-contract'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { sweepProviderByPrefix } from '../runtime/worktree-pty-surface-sweeps'

const row = (id = 'shared', incarnationId = 'live'): PtyProcessInfo => ({
  id,
  incarnationId,
  cwd: '/project',
  title: 'shell'
})
const deferred = () => Promise.withResolvers<PtyProcessInfo[]>()

function adapter(listProcesses: IPtyProvider['listProcesses']) {
  const provider = createAdapter('inventory')
  vi.mocked(provider.listProcesses).mockImplementation(listProcesses)
  return provider
}

describe('daemon inventory lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('takes post-cleanup observations after a timed-out restore and stops an externally created PTY', async () => {
    vi.useFakeTimers()
    const worktreeId = 'repo::/project'
    const targetId = `${worktreeId}@@external`
    let rows: PtyProcessInfo[] = []
    const fast = adapter(async () => [...rows])
    const slowReply = deferred()
    const slow = adapter(vi.fn().mockReturnValueOnce(slowReply.promise).mockResolvedValue([]))
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const restoring = resolver.resolve('missing-restore-pane')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(restoring).resolves.toEqual({ kind: 'unknown' })
    rows = [row(targetId)]
    const facade = adapter((opts) => resolver.listProcesses(opts))
    vi.mocked(facade.shutdown).mockImplementation(async (id) => {
      rows = rows.filter((process) => process.id !== id)
    })
    const sweep = sweepProviderByPrefix(
      worktreeId,
      facade,
      Date.now() + 10_000,
      async (_id, stop) => {
        const stopped = await stop()
        return { stopped, owner: stopped }
      },
      undefined,
      true
    )
    expect(fast.listProcesses).toHaveBeenCalledOnce()
    slowReply.resolve([])

    await expect(sweep).resolves.toBe(1)
    expect(facade.shutdown).toHaveBeenCalledExactlyOnceWith(targetId, expect.anything())
    expect(rows).toEqual([])
    expect(fast.listProcesses).toHaveBeenCalledTimes(2)
    expect(slow.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('coalesces staggered fresh readers and increasing deadlines behind one active diagnostic', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const owner = adapter(vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue([row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(21_000)
    const readers = Array.from({ length: 20 }, (_, index) =>
      resolver.listProcesses({
        ptyIds: ['shared'],
        deadlineMs: Date.now() + 9_500 + index
      })
    )
    await vi.advanceTimersByTimeAsync(100)
    const staggered = resolver.listProcesses({ ptyIds: ['shared'], deadlineMs: Date.now() + 9_500 })
    expect(owner.listProcesses).toHaveBeenCalledOnce()
    original.resolve([])

    await expect(diagnostic).resolves.toEqual([])
    for (const result of await Promise.all([...readers, staggered])) {
      expect(result).toEqual([row()])
    }
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('shares one diagnostic acquisition across twenty increasing long deadlines', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const owner = adapter(() => original.promise)
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(0)
    const readers = Array.from({ length: 20 }, (_, index) =>
      resolver.listProcesses({
        includeUnrouted: true,
        deadlineMs: Date.now() + 31_000 + index * 1_000
      })
    )
    expect(owner.listProcesses).toHaveBeenCalledOnce()
    original.resolve([])

    expect(await Promise.all([diagnostic, ...readers])).toEqual(
      Array.from({ length: 21 }, () => [])
    )
    expect(owner.listProcesses).toHaveBeenCalledOnce()
  })

  it('does not let invalidated absence pass after a newer route is recorded, and drains the queue', async () => {
    const old = deferred()
    const owner = adapter(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue([row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const older = expect(resolver.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await Promise.resolve()
    resolver.recordRoute('shared', owner, 'live')
    const newer = resolver.listProcesses({ ptyIds: ['shared'] })
    old.resolve([])

    await older
    await expect(newer).resolves.toEqual([row()])
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('rejects invalidated resolve and probe authority without rolling back a newer input route', async () => {
    const oldA = deferred()
    const oldB = deferred()
    const first = adapter(vi.fn().mockReturnValueOnce(oldA.promise).mockResolvedValue([]))
    const second = adapter(
      vi
        .fn()
        .mockReturnValueOnce(oldB.promise)
        .mockResolvedValue([row('shared', 'new')])
    )
    const routes = new Map<string, IPtyProvider>()
    const resolver = new DaemonSessionOwnerResolver([first, second], routes)
    const resolution = resolver.resolve('shared')
    const liveness = resolver.probe('shared')
    await Promise.resolve()
    resolver.recordRoute('shared', second, 'new')
    const fresh = resolver.listProcesses({ ptyIds: ['shared'] })
    oldA.resolve([row('shared', 'old')])
    oldB.resolve([])

    await expect(resolution).resolves.toEqual({ kind: 'unknown' })
    await expect(liveness).resolves.toBeNull()
    await expect(fresh).resolves.toEqual([row('shared', 'new')])
    expect(routes.get('shared')).toBe(second)
    expect(resolver.getVerifiedRoute('shared')).toBe(second)
  })

  it.each(['responsive', 'wedged'] as const)(
    'shares exact positive restore, probe and termination proof from a %s diagnostic',
    async (kind) => {
      vi.useFakeTimers()
      const slowReply = deferred()
      const fast = adapter(async () => [row()])
      const slow = adapter(() => slowReply.promise)
      const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
      const diagnostic = resolver.listProcesses({ includeUnrouted: true })
      await vi.advanceTimersByTimeAsync(100)
      const startedAt = Date.now()
      const restore = resolver.resolve('shared', 'live')
      const probe = resolver.probe('shared')
      const termination = resolver.resolveTermination('shared', 'live')
      if (kind === 'responsive') {
        slowReply.resolve([])
      }
      await vi.advanceTimersByTimeAsync(kind === 'responsive' ? 0 : 2_000)

      await expect(restore).resolves.toEqual({ kind: 'owner', provider: fast })
      await expect(probe).resolves.toBe(true)
      await expect(termination).resolves.toEqual({ kind: 'owner', provider: fast })
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000)
      slowReply.resolve([])
      await diagnostic
      expect(fast.listProcesses).toHaveBeenCalledOnce()
      expect(slow.listProcesses).toHaveBeenCalledOnce()
    }
  )

  it('never borrows stale absence or replacement proof from a pending diagnostic', async () => {
    vi.useFakeTimers()
    const slowReply = deferred()
    const fast = adapter(async () => [row('shared', 'replacement')])
    const slow = adapter(() => slowReply.promise)
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(100)
    const restore = resolver.resolve('missing')
    const probe = resolver.probe('missing')
    const termination = resolver.resolveTermination('shared', 'old')
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(restore).resolves.toEqual({ kind: 'unknown' })
    await expect(probe).resolves.toBeNull()
    await expect(termination).resolves.toEqual({ kind: 'unknown' })
    slowReply.resolve([])
    await diagnostic
    expect(fast.listProcesses).toHaveBeenCalledOnce()
    expect(slow.listProcesses).toHaveBeenCalledOnce()
  })

  it('refreshes borrowed absence within the original reader deadline after a responsive diagnostic', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const first = adapter(vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue([row()]))
    const second = adapter(async () => [])
    const resolver = new DaemonSessionOwnerResolver([first, second], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(100)
    const probe = resolver.probe('shared')
    original.resolve([])
    await vi.advanceTimersByTimeAsync(0)

    await diagnostic
    await expect(probe).resolves.toBe(true)
    expect(first.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('discards an expired queued batch without dispatching RPCs, then accepts a later reader', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const owner = adapter(vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue([row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(0)
    const expired = expect(
      resolver.listProcesses({ deadlineMs: Date.now() + 100 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    await vi.advanceTimersByTimeAsync(100)
    await expired
    original.resolve([])
    await diagnostic
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.listProcesses).toHaveBeenCalledOnce()

    await expect(resolver.listProcesses()).resolves.toEqual([row()])
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('checks queued reader expiry even before an overdue timeout callback executes', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const owner = adapter(() => original.promise)
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(0)
    const expired = expect(
      resolver.listProcesses({ deadlineMs: Date.now() + 100 })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    vi.setSystemTime(Date.now() + 101)
    original.resolve([])

    await diagnostic
    await expired
    expect(owner.listProcesses).toHaveBeenCalledOnce()
  })

  it('starts a queued default RPC budget at dispatch and retries failed providers in that fresh batch', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const owner = adapter(
      vi
        .fn()
        .mockReturnValueOnce(original.promise)
        .mockImplementation(async (opts) => {
          expect(opts?.deadlineMs).toBe(Date.now() + 30_000)
          return [row()]
        })
    )
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = expect(resolver.listProcesses({ includeUnrouted: true })).rejects.toThrow(
      'offline'
    )
    await vi.advanceTimersByTimeAsync(0)
    const fresh = resolver.listProcesses()
    await vi.advanceTimersByTimeAsync(25_000)
    original.reject(new Error('offline'))

    await diagnostic
    await expect(fresh).resolves.toEqual([row()])
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('drains unexpected failure only after all provider work settles', async () => {
    const original = deferred()
    const unexpected = new Error('gone classifier failed')
    const first = adapter(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]))
    const second = adapter(vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue([]))
    const resolver = new DaemonSessionOwnerResolver([first, second], new Map(), () => {
      throw unexpected
    })
    const diagnostic = expect(resolver.listProcesses({ includeUnrouted: true })).rejects.toBe(
      unexpected
    )
    await Promise.resolve()
    const fresh = resolver.listProcesses()
    await Promise.resolve()
    expect(first.listProcesses).toHaveBeenCalledOnce()
    original.resolve([])

    await diagnostic
    await expect(fresh).resolves.toEqual([])
    expect(first.listProcesses).toHaveBeenCalledTimes(2)
    expect(second.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('keeps one original deadline across borrowed-positive and fresh-absence stages', async () => {
    vi.useFakeTimers()
    const original = deferred()
    const refreshed = deferred()
    const first = adapter(
      vi.fn().mockReturnValueOnce(original.promise).mockReturnValueOnce(refreshed.promise)
    )
    const second = adapter(async () => [])
    const resolver = new DaemonSessionOwnerResolver([first, second], new Map())
    const diagnostic = resolver.listProcesses({ includeUnrouted: true })
    await vi.advanceTimersByTimeAsync(100)
    const startedAt = Date.now()
    const probe = resolver.probe('shared')
    await vi.advanceTimersByTimeAsync(1_500)
    original.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    await diagnostic
    expect(first.listProcesses).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)

    await expect(probe).resolves.toBeNull()
    expect(Date.now() - startedAt).toBe(2_000)
    refreshed.resolve([])
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not turn an unknown cached owner inventory into absence for another session', async () => {
    const first = adapter(async () => [row('ambiguous', 'first')])
    const second = adapter(async () => [row('ambiguous', 'second')])
    const resolver = new DaemonSessionOwnerResolver([first, second], new Map())
    await expect(resolver.resolve('ambiguous')).resolves.toEqual({ kind: 'unknown' })
    vi.mocked(first.listProcesses).mockResolvedValue([row('externally-created')])

    await expect(resolver.resolve('externally-created')).resolves.toEqual({ kind: 'unknown' })
    expect(first.listProcesses).toHaveBeenCalledOnce()
  })

  it('releases a cancelled queued batch and drains a fresh batch after identity invalidation', async () => {
    const original = deferred()
    const owner = adapter(vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue([row()]))
    const resolver = new DaemonSessionOwnerResolver([owner], new Map())
    const diagnostic = expect(
      resolver.listProcesses({ includeUnrouted: true })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    await Promise.resolve()
    const cancelled = expect(resolver.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    resolver.invalidateProvider(owner)
    const fresh = resolver.listProcesses()
    original.resolve([])

    await diagnostic
    await cancelled
    await expect(fresh).resolves.toEqual([row()])
    expect(owner.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('indexes each partial revision once across one hundred restore timeouts', async () => {
    vi.useFakeTimers()
    let idReads = 0
    const rows = Array.from({ length: 4_096 }, (_, index) => ({
      get id() {
        idReads += 1
        return `session-${index}`
      },
      cwd: '',
      title: 'shell'
    }))
    const slowReply = deferred()
    const fast = adapter(async () => rows)
    const slow = adapter(() => slowReply.promise)
    const resolver = new DaemonSessionOwnerResolver([fast, slow], new Map())
    const restores = Promise.all(
      Array.from({ length: 100 }, (_, index) => resolver.resolve(`missing-${index}`))
    )
    await vi.advanceTimersByTimeAsync(2_000)

    expect((await restores).every((result) => result.kind === 'unknown')).toBe(true)
    expect(idReads).toBe(8_192)
    slowReply.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(idReads).toBe(16_384)
    expect(fast.listProcesses).toHaveBeenCalledOnce()
    expect(slow.listProcesses).toHaveBeenCalledOnce()
  })
})
