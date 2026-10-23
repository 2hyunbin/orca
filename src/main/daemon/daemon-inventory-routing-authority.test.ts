import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

function setup(kind: 'router' | 'degraded') {
  const currentSessions: string[] = []
  const legacySessions = ['shared']
  const current = createAdapter('current', currentSessions, undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', legacySessions, undefined, PROTOCOL_VERSION)
  const fallback = createAdapter('fallback')
  const provider =
    kind === 'router'
      ? new DaemonPtyRouter({ current, legacy: [legacy] })
      : new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const discover = () =>
    provider instanceof DaemonPtyRouter
      ? provider.discoverLegacySessions()
      : provider.discoverDaemonSessions()
  return { current, legacy, fallback, currentSessions, legacySessions, provider, discover }
}

const request = {
  id: 'shared',
  expectedIncarnationId: 'old',
  requireNoAgentOwner: true,
  requireUnattached: true
}

describe.each(['router', 'degraded'] as const)('%s inventory input authority', (kind) => {
  afterEach(() => vi.useRealTimers())

  it('preserves a legacy input recipient without incarnation metadata across diagnostic reads', async () => {
    const { provider, discover, current, legacy, currentSessions } = setup(kind)
    await discover()
    provider.write('shared', 'before')
    currentSessions.push('shared')

    const diagnostic = await provider.listProcesses({ includeUnrouted: true })
    provider.write('shared', 'after')

    expect(vi.mocked(legacy.write).mock.calls).toEqual([
      ['shared', 'before'],
      ['shared', 'after']
    ])
    expect(current.write).not.toHaveBeenCalled()
    expect(diagnostic).toHaveLength(2)
    expect(diagnostic.every((row) => row.routed === undefined)).toBe(true)
    expect(provider.supportsFencedTermination('shared')).toBe(false)
    expect(provider.providesAgentSessionOwnerListings('shared')).toBe(false)
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unverifiable'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('retains input authority without certifying an incarnation reported by two daemons', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    const row = { id: 'shared', incarnationId: 'old', cwd: '', title: 'shell' }
    vi.mocked(legacy.listProcesses).mockResolvedValue([row])
    await discover()
    vi.mocked(current.listProcesses).mockResolvedValue([row])

    const diagnostic = await provider.listProcesses({ includeUnrouted: true })
    provider.write('shared', 'still legacy')

    expect(diagnostic.every((entry) => entry.routed === undefined)).toBe(true)
    expect(provider.supportsFencedTermination('shared')).toBe(false)
    expect(provider.providesAgentSessionOwnerListings('shared')).toBe(false)
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'still legacy')
    expect(current.write).not.toHaveBeenCalled()
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unverifiable'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('does not redirect input or terminate a newer replacement discovered on another daemon', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockResolvedValue([
      { id: 'shared', incarnationId: 'old', cwd: '', title: 'old' }
    ])
    await discover()
    vi.mocked(legacy.listProcesses).mockResolvedValue([])
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: 'shared', incarnationId: 'new', cwd: '', title: 'new' }
    ])

    await expect(provider.listProcesses({ includeUnrouted: true })).resolves.toEqual([
      expect.objectContaining({ incarnationId: 'new' })
    ])
    provider.write('shared', 'established recipient')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'established recipient')
    expect(current.write).not.toHaveBeenCalled()
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(provider.killFenced(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'replaced'
    })
    expect(current.killFenced).not.toHaveBeenCalled()
    expect(legacy.killFenced).not.toHaveBeenCalled()
  })

  it('keeps input authority when a diagnostic inventory is incomplete', async () => {
    const { provider, discover, current, legacy } = setup(kind)
    await discover()
    vi.mocked(current.listProcesses).mockRejectedValue(new Error('inventory unavailable'))

    await expect(provider.listProcesses({ includeUnrouted: true })).rejects.toThrow(
      'inventory unavailable'
    )
    provider.write('shared', 'still legacy')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith('shared', 'still legacy')
    expect(current.write).not.toHaveBeenCalled()
  })

  it.each(['short-first', 'long-first'] as const)(
    'honors a long inventory budget while independently bounding a short reader (%s)',
    async (order) => {
      vi.useFakeTimers()
      const { provider, current, legacy } = setup(kind)
      const rows = [{ id: 'slow', incarnationId: 'live', cwd: '', title: 'shell' }]
      vi.mocked(current.listProcesses).mockImplementation(
        (opts) =>
          new Promise<PtyProcessInfo[]>((resolve, reject) => {
            const success = setTimeout(() => {
              clearTimeout(timeout)
              resolve(rows)
            }, 3_000)
            const timeout = setTimeout(
              () => {
                clearTimeout(success)
                reject(new Error('daemon inventory timed out'))
              },
              opts?.deadlineMs === undefined ? 30_000 : opts.deadlineMs - Date.now()
            )
          })
      )
      const long = () => provider.listProcesses({ deadlineMs: Date.now() + 10_000 })
      const short = () => provider.listProcesses({ deadlineMs: Date.now() + 100 })
      const [first, second] = order === 'short-first' ? [short(), long()] : [long(), short()]
      const shortResult = Promise.allSettled([order === 'short-first' ? first : second])
      const longResult = Promise.allSettled([order === 'short-first' ? second : first])

      await vi.advanceTimersByTimeAsync(100)
      expect(await shortResult).toEqual([
        { status: 'rejected', reason: expect.any(TerminalSessionOwnerUnverifiedError) }
      ])
      await vi.advanceTimersByTimeAsync(2_900)
      expect(await longResult).toEqual([
        {
          status: 'fulfilled',
          value: [...rows, { id: 'shared', cwd: '', title: 'legacy' }]
        }
      ])
      expect(current.listProcesses).toHaveBeenCalledOnce()
      expect(legacy.listProcesses).toHaveBeenCalledOnce()
    }
  )

  it('bounds an attach joining a longer inventory without cancelling the listing', async () => {
    vi.useFakeTimers()
    const { provider, current, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockResolvedValue([])
    const rows = [{ id: 'shared', incarnationId: 'live', cwd: '', title: 'shell' }]
    vi.mocked(current.listProcesses).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(rows), 3_000))
    )
    const listing = expect(
      provider.listProcesses({ deadlineMs: Date.now() + 10_000 })
    ).resolves.toEqual(rows)
    const attaching = expect(
      provider.spawn({
        sessionId: 'shared',
        expectedIncarnationId: 'live',
        expectedIncarnationIsAuthoritative: true,
        attachOnly: true,
        cols: 80,
        rows: 24
      })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)

    await vi.advanceTimersByTimeAsync(2_000)
    await attaching
    expect(current.spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await listing
    expect(current.listProcesses).toHaveBeenCalledOnce()
  })

  it('reuses an incomplete restore snapshot while the shared inventory continues', async () => {
    vi.useFakeTimers()
    const { provider, current, legacy } = setup(kind)
    vi.mocked(legacy.listProcesses).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve([{ id: 'shared', incarnationId: 'live', cwd: '', title: 'shell' }]),
            3_000
          )
        )
    )
    const attach = () =>
      provider.spawn({ sessionId: 'missing', attachOnly: true, cols: 80, rows: 24 })
    const first = expect(attach()).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    await vi.advanceTimersByTimeAsync(2_000)
    await first

    for (let index = 0; index < 20; index++) {
      await expect(attach()).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    }
    expect(current.listProcesses).toHaveBeenCalledOnce()
    expect(legacy.listProcesses).toHaveBeenCalledOnce()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    provider.write('shared', 'discovered after restore timed out')
    expect(legacy.write).toHaveBeenCalledExactlyOnceWith(
      'shared',
      'discovered after restore timed out'
    )
  })
})
