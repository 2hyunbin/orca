import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { AiVaultRowDelta, AiVaultScanRows } from '../../shared/ai-vault-scan-rows'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'

const EMPTY_RESULT = { sessions: [], issues: [], scannedAt: '2026-07-27T00:00:00.000Z' }

describe('AiVaultScanCoordinator', () => {
  it('keeps a shared scan alive when only one caller cancels', async () => {
    const coordinator = new AiVaultScanCoordinator()
    let resolveScan: ((result: typeof EMPTY_RESULT) => void) | undefined
    let sharedSignal: AbortSignal | undefined
    const start = vi.fn(
      (signal: AbortSignal) =>
        new Promise<typeof EMPTY_RESULT>((resolve) => {
          sharedSignal = signal
          resolveScan = resolve
        })
    )
    const controller = new AbortController()
    const first = coordinator.run({ key: 'scope', signal: controller.signal, start })
    const second = coordinator.run({ key: 'scope', start })
    await Promise.resolve()

    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)
    resolveScan?.(EMPTY_RESULT)
    await expect(second).resolves.toEqual(EMPTY_RESULT)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('preempts a non-forced scan and re-joins its caller onto the forced scan', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const signals: AbortSignal[] = []
    let resolveForced: ((result: typeof EMPTY_RESULT) => void) | undefined
    const start = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<typeof EMPTY_RESULT>((resolve) => {
        if (signals.length === 1) {
          signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
        } else {
          resolveForced = resolve
        }
      })
    })
    const first = coordinator.run({ key: 'scope', start })
    await Promise.resolve()

    const forced = coordinator.run({ key: 'scope', force: true, start })
    const joined = coordinator.run({ key: 'scope', force: true, start })
    await Promise.resolve()

    expect(signals[0]?.aborted).toBe(true)
    expect(start).toHaveBeenCalledTimes(2)
    resolveForced?.(EMPTY_RESULT)
    // The first caller never asked to cancel, so someone else's Refresh must
    // hand it the replacement's result instead of a spurious cancellation.
    await expect(Promise.all([first, forced, joined])).resolves.toEqual([
      EMPTY_RESULT,
      EMPTY_RESULT,
      EMPTY_RESULT
    ])
  })

  it('keeps coalescing forced callers onto a forced scan that is still fresh', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AiVaultScanCoordinator()
      let resolveScan: ((result: typeof EMPTY_RESULT) => void) | undefined
      const start = vi.fn(
        () =>
          new Promise<typeof EMPTY_RESULT>((resolve) => {
            resolveScan = resolve
          })
      )
      const first = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      vi.advanceTimersByTime(4_999)
      const second = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      expect(start).toHaveBeenCalledTimes(1)
      resolveScan?.(EMPTY_RESULT)
      // Both callers settle off the single shared scan instead of preempting it.
      await expect(Promise.all([first, second])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a forced refresh preempt a forced scan that hung past the coalescing window', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AiVaultScanCoordinator()
      const signals: AbortSignal[] = []
      let resolveSecond: ((result: typeof EMPTY_RESULT) => void) | undefined
      const start = vi.fn((signal: AbortSignal) => {
        signals.push(signal)
        return new Promise<typeof EMPTY_RESULT>((resolve) => {
          if (signals.length > 1) {
            resolveSecond = resolve
          }
        })
      })
      const stuck = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      vi.advanceTimersByTime(5_000)
      const retry = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      expect(signals[0]?.aborted).toBe(true)
      expect(start).toHaveBeenCalledTimes(2)
      resolveSecond?.(EMPTY_RESULT)
      // The caller stranded on the hung scan rides the replacement out rather
      // than being told its own refresh was cancelled.
      await expect(Promise.all([stuck, retry])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh scan after every waiter cancels', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const signals: AbortSignal[] = []
    const start = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      if (signals.length > 1) {
        return Promise.resolve(EMPTY_RESULT)
      }
      return new Promise<typeof EMPTY_RESULT>((resolve) => {
        signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
      })
    })
    const controller = new AbortController()
    const first = coordinator.run({ key: 'scope', signal: controller.signal, start })
    await Promise.resolve()
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    const second = coordinator.run({ key: 'scope', start })

    await expect(second).resolves.toEqual(EMPTY_RESULT)
    expect(start).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)
  })
})

it('attaches a coherent current snapshot and rejects publications from retired generations', async () => {
  const coordinator = new AiVaultScanCoordinator()
  const views: AiVaultScanRows[] = []
  const publishers: ((delta: AiVaultRowDelta) => void)[] = []
  const finishers: (() => void)[] = []
  const start = (_signal: AbortSignal, publish: (delta: AiVaultRowDelta) => void) => {
    publishers.push(publish)
    return new Promise<typeof EMPTY_RESULT>((resolve) => { finishers.push(() => resolve(EMPTY_RESULT)) })
  }
  const row: AiVaultSession = {
    id: 'local:codex:one:/one.jsonl', executionHostId: 'local', agent: 'codex', sessionId: 'one',
    title: 'One', filePath: '/one.jsonl', codexHome: null, cwd: '/repo', branch: null, model: null,
    createdAt: null, updatedAt: null, modifiedAt: '2026-01-01', messageCount: 1, totalTokens: 0,
    previewMessages: [], queuedMessageCount: 0, subagentTranscriptCount: 0,
    resumeCommand: 'codex resume one', subagent: null
  }
  const first = coordinator.run({ key: 'scope', start, onRows: (view) => views.push(view) })
  await Promise.resolve()
  publishers[0]!({ upserts: [row], removed: [] })
  const late: AiVaultScanRows[] = []
  const second = coordinator.run({ key: 'scope', start, onRows: (view) => late.push(view) })
  expect(late[0]).toMatchObject({ kind: 'snapshot', revision: views.at(-1)?.revision })
  const snapshot = late[0]
  expect(snapshot?.kind === 'snapshot' ? snapshot.sessions : []).toEqual([row])
  publishers[0]!({ upserts: [{ ...row, title: 'Updated' }], removed: [] })
  const update = late.at(-1)
  expect(update?.kind === 'delta' ? update.delta.upserts[0]?.title : null).toBe('Updated')
  const forced = coordinator.run({ key: 'scope', force: true, start })
  await Promise.resolve()
  const revision = views.at(-1)
  publishers[0]!({ upserts: [], removed: ['stale'] })
  expect(views.at(-1)).toBe(revision)
  coordinator.invalidate()
  const count = views.length
  publishers[1]!({ upserts: [], removed: [] })
  expect(views).toHaveLength(count)
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  await expect(forced).rejects.toMatchObject({ name: 'AbortError' })
  for (const finish of finishers) finish()
})
