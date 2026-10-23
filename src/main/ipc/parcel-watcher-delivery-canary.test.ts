import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherCanaryActivity } from './parcel-watcher-delivery-canary'

const { detectShallowWatchDeliveryMock, subscribeMock, watchMock, writeFileSyncMock } = vi.hoisted(
  () => ({
    detectShallowWatchDeliveryMock: vi.fn(),
    subscribeMock: vi.fn(),
    watchMock: vi.fn(),
    writeFileSyncMock: vi.fn()
  })
)

vi.mock('node:fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-canary-test'),
  rmSync: vi.fn(),
  watch: watchMock,
  writeFileSync: writeFileSyncMock
}))
vi.mock('./shallow-watch-delivery-probe', () => ({
  detectShallowWatchDelivery: detectShallowWatchDeliveryMock
}))
vi.mock('@parcel/watcher', () => ({ subscribe: subscribeMock }))

type Delivery = { native: boolean; independent: boolean }

describe('watcher delivery canary', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let originalExitListeners: NodeJS.ExitListener[]
  let delivery: Delivery
  let canaryWrites: number[]
  let stderr: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  const start = async (activity: WatcherCanaryActivity): Promise<void> => {
    const { startWatcherDeliveryCanary } = await import('./parcel-watcher-delivery-canary')
    await startWatcherDeliveryCanary(() => activity)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.resetModules()
    setPlatform('linux')
    originalExitListeners = process.listeners('exit')
    delivery = { native: false, independent: false }
    canaryWrites = []
    stderr = []
    let nativeCallback: ((err: Error | null) => void) | undefined
    let independentListener: (() => void) | undefined
    subscribeMock.mockReset().mockImplementation(async (_dir, callback) => {
      nativeCallback = callback
      return { unsubscribe: vi.fn() }
    })
    detectShallowWatchDeliveryMock.mockReset().mockResolvedValue(true)
    watchMock.mockReset().mockImplementation((_dir, _opts, listener: () => void) => {
      independentListener = listener
      return Object.assign(new EventEmitter(), {
        close: () => {
          independentListener = undefined
        }
      })
    })
    writeFileSyncMock.mockReset().mockImplementation((path: string) => {
      if (path.endsWith('canary.txt')) {
        canaryWrites.push(Date.now())
      }
      if (delivery.native) {
        nativeCallback?.(null)
      }
      if (delivery.independent) {
        independentListener?.()
      }
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub must return so the canary's post-exit path is observable; it is never used as a real exit.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    for (const listener of process.listeners('exit')) {
      if (!originalExitListeners.includes(listener)) {
        process.off('exit', listener)
      }
    }
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the child and backs off when the system event source is stalled', async () => {
    await start({ revision: 1, liveSubscriptions: 1, pendingCrawlStartedAt: null })

    await vi.advanceTimersByTimeAsync(300_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(watchMock).toHaveBeenCalled()
    expect(stderr.join('')).toContain('system file events stalled')
    // Checks at 10 s and 20 s miss; each stalled probe then doubles the wait (30 s, 60 s, 120 s).
    expect(canaryWrites).toEqual([10_000, 20_000, 60_000, 130_000, 260_000])

    delivery.native = true
    await vi.advanceTimersByTimeAsync(270_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('system file events recovered')
    const afterRecovery = canaryWrites.filter((time) => time > 260_000)
    expect(afterRecovery.slice(0, 3)).toEqual([510_000, 520_000, 530_000])
  })

  it('restarts when fs.watch still delivers but the native canary is starved', async () => {
    delivery.independent = true
    await start({ revision: 1, liveSubscriptions: 1, pendingCrawlStartedAt: null })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderr.join('')).toContain('canary starved while fs.watch delivered')
  })

  it('keeps the previous restart behaviour where fs.watch was never proven to work', async () => {
    detectShallowWatchDeliveryMock.mockResolvedValue(false)
    await start({ revision: 1, liveSubscriptions: 1, pendingCrawlStartedAt: null })

    await vi.advanceTimersByTimeAsync(25_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('does not restart when the native canary answers the independent probe', async () => {
    await start({ revision: 1, liveSubscriptions: 1, pendingCrawlStartedAt: null })
    await vi.advanceTimersByTimeAsync(25_000)
    delivery.native = true

    await vi.advanceTimersByTimeAsync(60_000)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(stderr.join('')).not.toContain('stalled')
  })

  it('detects a deadlocked pending subscribe on macOS', async () => {
    setPlatform('darwin')
    delivery.independent = true
    await start({ revision: 1, liveSubscriptions: 0, pendingCrawlStartedAt: 0 })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('waits out a long crawl on crawling backends before treating it as stuck', async () => {
    delivery.independent = true
    await start({ revision: 1, liveSubscriptions: 1, pendingCrawlStartedAt: 0 })

    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(canaryWrites).toEqual([])
    expect(exitSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})

describe('armedCanaryRevision', () => {
  it('arms for live subscriptions and disarms when idle', async () => {
    const { armedCanaryRevision } = await import('./parcel-watcher-delivery-canary')
    const idle = { revision: 4, liveSubscriptions: 0, pendingCrawlStartedAt: null }
    expect(armedCanaryRevision(idle, 0, 'linux')).toBeNull()
    expect(armedCanaryRevision({ ...idle, liveSubscriptions: 2 }, 0, 'win32')).toBe(4)
  })

  it('arms during a pending subscribe on macOS but only after the crawl grace elsewhere', async () => {
    const { armedCanaryRevision, CANARY_PENDING_CRAWL_GRACE_MS } =
      await import('./parcel-watcher-delivery-canary')
    const pending = { revision: 7, liveSubscriptions: 1, pendingCrawlStartedAt: 1_000 }
    expect(armedCanaryRevision(pending, 1_000, 'darwin')).toBe(7)
    expect(armedCanaryRevision(pending, 1_000, 'linux')).toBeNull()
    expect(armedCanaryRevision(pending, 1_000 + CANARY_PENDING_CRAWL_GRACE_MS, 'win32')).toBe(7)
  })
})
