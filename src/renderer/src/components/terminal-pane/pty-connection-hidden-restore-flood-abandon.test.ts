import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import {
  clearHiddenRendererPtyDeliveryState,
  consumeHiddenRendererPtyDropMemory,
  markHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  unmarkHiddenRendererPty
} from '../../../../main/ipc/pty-hidden-delivery-gate'

// STA-4869 — routes R3 (pending-queue overflow, pty-connection.ts:7696) and R4
// (loop iteration cap, 7702) end in the QUIET abandon, which trades the loss
// banner for one deferred post-flood repaint. Same invariant as the non-quiet
// routes: every retained byte is reconciled exactly once, or the loss is
// disclosed. These cases must also survive the pane being scrolled back or
// hidden when the deferred repaint comes due.

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep,
  warnTerminalLifecycleAnomaly
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  warnTerminalLifecycleAnomaly: vi.fn()
}))

// The iteration-cap warning is the only externally visible proof that R4's
// backstop fired rather than the loop finishing on its own.
vi.mock('./terminal-lifecycle-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  warnTerminalLifecycleAnomaly
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const PTY_ID = 'pty-id'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const R3_MARKER = 'R3-LOST-4d17'
const R4_MARKER = 'R4-LOST-8ba0'
// One char over HIDDEN_OUTPUT_RESTORE_PENDING_CHARS (512KB): the queue discards
// its whole backlog and latches overflow.
const OVERFLOW_CHUNK = 'o'.repeat(512 * 1024 + 1)

type MainSnapshot = { data: string; cols: number; rows: number; seq: number }

function modelSnapshot(marker: string, seq: number): MainSnapshot {
  return { data: `${marker}\r\n`, cols: 120, rows: 40, seq }
}

type PaneDrive = {
  pane: MockPane
  transport: MockTransport
  deps: PaneConnectionDeps
  disposable: { dispose: () => void }
  deliver: (data: string, seq: number) => void
  setVisible: (visible: boolean) => void
  writtenChunks: () => string[]
}

async function connectVisiblePane(): Promise<PaneDrive> {
  const transport = createMockTransport(PTY_ID)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: true }
  })
  const disposable = await connectMockPanePty(pane, createManager(1), deps)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    transport,
    deps,
    disposable,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (visible) => {
      deps.isVisibleRef.current = visible
    },
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

async function announceMainDrop(
  markerSeq: number | undefined,
  hiddenDropEpisode?: number,
  reason: 'hidden-drop' | 'unhide' | 'pending-cap' = 'hidden-drop',
  ptyId = PTY_ID
): Promise<void> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  _dispatchPtyModelRestoreNeededForTest({
    id: ptyId,
    reason,
    ...(markerSeq !== undefined ? { markerSeq } : {}),
    ...(hiddenDropEpisode !== undefined ? { hiddenDropEpisode } : {})
  })
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

type Disclosure = {
  bannerWrites: number
  markerWrites: number
  disclosedOrRecovered: boolean
}

function observeDisclosure(drive: PaneDrive, marker: string): Disclosure {
  const written = drive.writtenChunks()
  const bannerWrites = written.filter((data) => data.includes(BANNER_FRAGMENT)).length
  const markerWrites = countOccurrences(written.join(''), marker)
  return {
    bannerWrites,
    markerWrites,
    disclosedOrRecovered: bannerWrites > 0 || markerWrites === 1
  }
}

function expectDisclosedOrRecovered(disclosure: Disclosure): void {
  expect(
    disclosure.disclosedOrRecovered,
    `hidden output was neither reconciled nor disclosed: ${JSON.stringify(disclosure)}`
  ).toBe(true)
}

describe('hidden-output restore quiet abandonment (STA-4869)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  describe('unhide markers delivered during a restore', () => {
    it('retires an episode first reported by unhide while an episode-less restore is pending', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('ACKNOWLEDGED_CAPTURE', 128))
      vi.mocked(window.api.pty.ackHiddenOutputRestoreApplied).mockImplementation(
        consumeHiddenRendererPtyDropMemory
      )
      markHiddenRendererPty(PTY_ID)
      const { hiddenDropEpisode } = recordHiddenRendererPtyDataDrop(PTY_ID, 64)
      unmarkHiddenRendererPty(PTY_ID)
      try {
        await announceMainDrop(64, undefined, 'pending-cap')
        await announceMainDrop(64, hiddenDropEpisode, 'unhide')
        first.resolve(modelSnapshot('FIRST_CAPTURE', 128))
        await flushAsyncTicks(40)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(40)
        const requestsBeforeQuietReveal = getMainBufferSnapshot.mock.calls.length
        const live = 'LIVE_IMAGE_AFTER_ACK_WINDOW\r\n'
        drive.deliver(live, 128 + live.length)
        await flushAsyncTicks(10)
        const writesBeforeQuietReveal = drive.writtenChunks().length
        const quietReveal = unmarkHiddenRendererPty(PTY_ID)
        expect.soft(quietReveal.droppedWhileHidden).toBe(false)
        if (quietReveal.droppedWhileHidden) {
          await announceMainDrop(64, quietReveal.hiddenDropEpisode, 'unhide')
        }
        await flushAsyncTicks(40)
        expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(requestsBeforeQuietReveal)
        expect(drive.writtenChunks().slice(writesBeforeQuietReveal).join('')).not.toContain(
          '\x1b[2J'
        )
      } finally {
        clearHiddenRendererPtyDeliveryState(PTY_ID)
        drive.disposable.dispose()
      }
    })

    it('keeps the unhide requirement until a repeatedly stale snapshot finally covers it', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(modelSnapshot('SECOND_STALE_CAPTURE', 128))
        .mockResolvedValueOnce(modelSnapshot('THIRD_COVERING_CAPTURE', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(256, 1, 'unhide')
        first.resolve(modelSnapshot('FIRST_STALE_CAPTURE', 128))
        await flushAsyncTicks(100)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(3)
        expect(drive.writtenChunks().join('')).toContain('THIRD_COVERING_CAPTURE')
        expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      } finally {
        drive.disposable.dispose()
      }
    })

    it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'does not treat snapshot sequence %s as covering the pending unhide',
      async (seq) => {
        const drive = await connectVisiblePane()
        vi.useFakeTimers()
        const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
        const first = createDeferred<{ data: string; cols: number; rows: number; seq?: number }>()
        getMainBufferSnapshot.mockReturnValueOnce(first.promise)
        getMainBufferSnapshot.mockResolvedValue(modelSnapshot('FINITE_COVERING_CAPTURE', 512))
        try {
          await announceMainDrop(64, 1)
          await announceMainDrop(256, 1, 'unhide')
          first.resolve({ ...modelSnapshot('UNPROVEN_CAPTURE', 128), seq })
          await flushAsyncTicks(70)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          expect(drive.writtenChunks().join('')).toContain('FINITE_COVERING_CAPTURE')
        } finally {
          drive.disposable.dispose()
        }
      }
    )

    it('consumes a covered unhide marker received after the response while its replay is parsing', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('REPLAY_PARSING', 128))
      const pendingParses: (() => void)[] = []
      const originalWrite = drive.pane.terminal.write.getMockImplementation()
      drive.pane.terminal.write.mockImplementation((data, callback) => {
        if ((data === '' || callback?.name === 'runParsedSteps') && callback) {
          pendingParses.push(callback)
        }
      })
      const finishParsing = async (): Promise<void> => {
        for (let round = 0; round < 10; round += 1) {
          while (pendingParses.length > 0) {
            pendingParses.shift()?.()
          }
          await flushAsyncTicks(10)
        }
      }
      try {
        await announceMainDrop(64, 1)
        await flushAsyncTicks(20)
        expect(drive.writtenChunks().join('')).toContain('REPLAY_PARSING')
        expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()
        await announceMainDrop(128, 1, 'unhide')
        await finishParsing()
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
        const live = 'LIVE_AFTER_PARSED_REPLAY\r\n'
        drive.deliver(live, 128 + live.length)
        await finishParsing()
        const beforeTimer = drive.writtenChunks().length

        await vi.advanceTimersByTimeAsync(2_100)
        await finishParsing()
        expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        expect(drive.writtenChunks().slice(beforeTimer).join('')).not.toContain('\x1b[2J')
      } finally {
        if (originalWrite) {
          drive.pane.terminal.write.mockImplementation(originalWrite)
        }
        drive.disposable.dispose()
      }
    })

    it('does not clear newer live output for an unhide marker the successful snapshot covered', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('UNNECESSARY_SECOND_REPLAY', 256))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1, 'unhide')
        first.resolve(modelSnapshot('COVERED_DROP', 128))
        await flushAsyncTicks(30)
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        const live = 'LIVE_AFTER_SUCCESS\r\n'
        drive.deliver(live, 128 + live.length)
        await flushAsyncTicks(10)
        expect(drive.writtenChunks().join('')).toContain(live)
        const beforeTimer = drive.writtenChunks().length
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)

        expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        expect(drive.writtenChunks().slice(beforeTimer).join('')).not.toContain('\x1b[2J')
      } finally {
        drive.disposable.dispose()
      }
    })

    it.each([
      { loss: 'a newer episode', markerSeq: 256, episode: 2 },
      { loss: 'a repeatedly reported newer episode', markerSeq: 256, episode: 2, repeat: true },
      { loss: 'covered bytes in a newly reported episode', markerSeq: 64, episode: 2 },
      { loss: 'covered bytes without an episode', markerSeq: 64, episode: undefined },
      { loss: 'newer bytes in the same episode', markerSeq: 256, episode: 1 },
      { loss: 'an episode-less marker', markerSeq: 256, episode: undefined },
      { loss: 'a sequence-less marker', markerSeq: undefined, episode: 1 }
    ])('still repaints $loss reported while the older snapshot was fetching', async (scenario) => {
      const { markerSeq, episode } = scenario
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('NEW_EPISODE_RECOVERED', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(markerSeq, episode, 'unhide')
        if ('repeat' in scenario && scenario.repeat) {
          await announceMainDrop(markerSeq, episode, 'unhide')
        }
        first.resolve(modelSnapshot('ONLY_OLD_EPISODE_COVERED', 128))
        await flushAsyncTicks(30)
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)

        const repairAlreadyPainted = getMainBufferSnapshot.mock.calls.length === 2
        const live = 'LIVE_AFTER_COVERING_REPAIR\r\n'
        if (repairAlreadyPainted) {
          drive.deliver(live, 512 + live.length)
          await flushAsyncTicks(10)
        }
        const writesBeforeTimer = drive.writtenChunks().length

        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        if (repairAlreadyPainted) {
          expect(drive.writtenChunks().slice(writesBeforeTimer).join('')).not.toContain('\x1b[2J')
        }
        expect(drive.writtenChunks().join('')).toContain('NEW_EPISODE_RECOVERED')
        if (episode !== undefined) {
          expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, episode)
        }
      } finally {
        drive.disposable.dispose()
      }
    })

    it('keeps the deferred repaint when pending live bytes overflow before the snapshot drains', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('OVERFLOW_RECOVERED', 1_000_000))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1)
        drive.deliver(OVERFLOW_CHUNK, 64 + OVERFLOW_CHUNK.length)
        first.resolve(modelSnapshot('PRE_OVERFLOW_ONLY', 128))
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).toContain('OVERFLOW_RECOVERED')
        expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      } finally {
        drive.disposable.dispose()
      }
    })

    it('keeps the existing repaint behavior for a pending-cap marker', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('PENDING_CAP_RECOVERED', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, undefined, 'pending-cap')
        first.resolve(modelSnapshot('EARLIER_CAPTURE', 128))
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).toContain('PENDING_CAP_RECOVERED')
      } finally {
        drive.disposable.dispose()
      }
    })

    it('fetches a fresh snapshot when hidden bytes arrived during the first fetch', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      const second = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1)
        drive.setVisible(false)
        drive.deliver('HIDDEN_AFTER_CAPTURE\r\n', 256)
        drive.setVisible(true)
        first.resolve(modelSnapshot('FIRST_CAPTURE', 128))
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(2_100)
        second.resolve(modelSnapshot('FRESH_CAPTURE', 512))
        await flushAsyncTicks(30)
        expect(drive.writtenChunks().join('')).toContain('FRESH_CAPTURE')
        expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      } finally {
        drive.disposable.dispose()
      }
    })

    it.each(['reject', 'unavailable'] as const)(
      'keeps recovery pending after the first snapshot is %s',
      async (failure) => {
        const drive = await connectVisiblePane()
        vi.useFakeTimers()
        const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
        const first = createDeferred<MainSnapshot | null>()
        getMainBufferSnapshot.mockReturnValueOnce(first.promise)
        getMainBufferSnapshot.mockResolvedValue(modelSnapshot('RECOVERED_AFTER_REFUSAL', 512))
        try {
          await announceMainDrop(64, 1)
          await announceMainDrop(64, 1, 'unhide')
          if (failure === 'reject') {
            first.reject(new Error('snapshot unavailable'))
          } else {
            first.resolve(null)
          }
          await flushAsyncTicks(30)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()

          await vi.advanceTimersByTimeAsync(75)
          await flushAsyncTicks(30)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          expect(drive.writtenChunks().join('')).toContain('RECOVERED_AFTER_REFUSAL')
          expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
          expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
        } finally {
          drive.disposable.dispose()
        }
      }
    )

    it('ignores a timed-out task without consuming the next restore request', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      const second = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1, 'unhide')
        const waitingLive = 'LIVE_HELD_FOR_TIMEOUT\r\n'
        drive.deliver(waitingLive, 64 + waitingLive.length)
        await vi.advanceTimersByTimeAsync(800)
        await flushAsyncTicks(30)
        expect(drive.writtenChunks().join('')).toContain(waitingLive)

        await announceMainDrop(256, 2)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        first.resolve(modelSnapshot('STALE_TIMED_OUT_CAPTURE', 128))
        await flushAsyncTicks(30)
        second.resolve(modelSnapshot('RECOVERED_AFTER_TIMEOUT', 512))
        await flushAsyncTicks(30)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).not.toContain('STALE_TIMED_OUT_CAPTURE')
        expect(drive.writtenChunks().join('')).toContain('RECOVERED_AFTER_TIMEOUT')
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 2)
      } finally {
        drive.disposable.dispose()
      }
    })

    it('does not let the retired PTY task consume an uncovered unhide for its successor', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const oldPtySnapshot = createDeferred<MainSnapshot>()
      const newPtySnapshot = createDeferred<MainSnapshot>()
      getMainBufferSnapshot
        .mockReturnValueOnce(oldPtySnapshot.promise)
        .mockReturnValueOnce(newPtySnapshot.promise)
        .mockResolvedValue(modelSnapshot('SUCCESSOR_NEW_GAP_RECOVERED', 1024))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1, 'unhide')
        drive.transport.getPtyId.mockReturnValue('successor-pty')
        drive.setVisible(false)
        drive.deliver('NEW_PTY_OUTPUT\r\n', 32)
        drive.setVisible(true)
        await announceMainDrop(32, 2, 'hidden-drop', 'successor-pty')
        await announceMainDrop(512, 2, 'unhide', 'successor-pty')

        oldPtySnapshot.resolve(modelSnapshot('RETIRED_PTY_CAPTURE', 2048))
        await flushAsyncTicks(30)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        newPtySnapshot.resolve(modelSnapshot('SUCCESSOR_OLD_CAPTURE', 128))
        await flushAsyncTicks(30)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(3)
        expect(drive.writtenChunks().join('')).not.toContain('RETIRED_PTY_CAPTURE')
        expect(drive.writtenChunks().join('')).toContain('SUCCESSOR_NEW_GAP_RECOVERED')
        expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalledWith(PTY_ID, 1)
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(
          'successor-pty',
          2
        )
      } finally {
        drive.disposable.dispose()
      }
    })

    it('recovers an unhide-only successor while a retired PTY snapshot is pending', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const oldPtySnapshot = createDeferred<MainSnapshot>()
      getMainBufferSnapshot
        .mockReturnValueOnce(oldPtySnapshot.promise)
        .mockResolvedValue(modelSnapshot('SUCCESSOR_UNHIDE_RECOVERED', 1024))
      try {
        await announceMainDrop(64, 1)
        drive.transport.getPtyId.mockReturnValue('successor-pty')
        drive.setVisible(false)
        drive.deliver('NEW_PTY_OUTPUT\r\n', 32)
        drive.setVisible(true)
        await announceMainDrop(512, 2, 'unhide', 'successor-pty')

        oldPtySnapshot.resolve(modelSnapshot('RETIRED_PTY_CAPTURE', 2048))
        await flushAsyncTicks(30)
        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).not.toContain('RETIRED_PTY_CAPTURE')
        expect(drive.writtenChunks().join('')).toContain('SUCCESSOR_UNHIDE_RECOVERED')
        expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalledWith(PTY_ID, 1)
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(
          'successor-pty',
          2
        )
      } finally {
        drive.disposable.dispose()
      }
    })

    it('cannot replay or acknowledge an unhide after its pane is disposed', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1, 'unhide')
      drive.disposable.dispose()
      const writesBeforeDisposal = drive.writtenChunks().slice()
      first.resolve(modelSnapshot('DISPOSED_PANE_CAPTURE', 128))
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(drive.writtenChunks()).toEqual(writesBeforeDisposal)
      expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()
    })
  })

  // ── R3: foreground pending-queue overflow ───────────────────────────────
  describe('R3 pending-queue overflow', () => {
    /** Drives one restore into a 512KB queue overflow and returns once the
     *  quiet abandon has run. */
    async function overflowRestoreQueue(drive: PaneDrive): Promise<void> {
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const firstSnapshot = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise)
      await announceMainDrop(64)
      await flushAsyncTicks(20)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      // The live stream outruns fetch+replay and blows the queue cap.
      drive.deliver(OVERFLOW_CHUNK, 64 + OVERFLOW_CHUNK.length)
      drive.deliver(OVERFLOW_CHUNK, 64 + 2 * OVERFLOW_CHUNK.length)
      // Resolve inside the 750ms foreground deadline so the drain, not the
      // deadline timer, owns the abandonment.
      firstSnapshot.resolve(modelSnapshot('pre-overflow-model', 64))
      await flushAsyncTicks(20)

      // Proof the overflow arm ran: the snapshot replayed, and the queued
      // backlog was discarded rather than drained under it.
      const written = drive.writtenChunks().join('')
      expect(written).toContain('pre-overflow-model')
      expect(written).not.toContain('o'.repeat(1024))
    }

    it('[invariant] reconciles the retained bytes through the deferred post-flood repaint', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      await overflowRestoreQueue(drive)

      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R3_MARKER, 4096))
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R3_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })

    it('[invariant] keeps recovery armed while the user reads scrollback', async () => {
      const { markTerminalFollowOutput, markTerminalPinnedViewport } =
        await import('@/lib/pane-manager/terminal-scroll-intent')
      const drive = await connectVisiblePane()
      drive.pane.terminal.buffer.active.baseY = 100
      drive.pane.terminal.buffer.active.viewportY = 42
      markTerminalPinnedViewport(drive.pane.terminal)
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      await overflowRestoreQueue(drive)

      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R4_MARKER, 4096))
      await vi.advanceTimersByTimeAsync(60_000)
      await flushAsyncTicks(20)
      // Parked, not abandoned: the repaint must not yank the viewport, and must
      // not claim a loss it can still heal.
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      expect(drive.pane.terminal.buffer.active.viewportY).toBe(42)

      // A background stint must not consume the parked recovery either.
      drive.setVisible(false)
      await vi.advanceTimersByTimeAsync(60_000)
      drive.setVisible(true)
      await flushAsyncTicks(20)

      drive.pane.terminal.buffer.active.viewportY = drive.pane.terminal.buffer.active.baseY
      markTerminalFollowOutput(drive.pane.terminal)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R4_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })

  // ── R4: restore loop iteration cap ──────────────────────────────────────
  describe('R4 loop iteration cap', () => {
    it('[invariant] reconciles the retained bytes after the iteration backstop fires', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const rounds = [0, 1, 2].map(() => createDeferred<MainSnapshot>())
      for (const round of rounds) {
        getMainBufferSnapshot.mockReturnValueOnce(round.promise)
      }
      await announceMainDrop(64)
      await flushAsyncTicks(20)

      // Each round: the pane goes background long enough for one chunk to arrive
      // with a restore in flight, which marks the in-flight snapshot stale and
      // sends the loop around again.
      for (const [index, round] of rounds.entries()) {
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(index + 1)
        drive.setVisible(false)
        drive.deliver(`stale-round-${index}\r\n`, 128 + index * 32)
        drive.setVisible(true)
        round.resolve(modelSnapshot(`round-${index}-model`, 64 + index))
        await flushAsyncTicks(20)
      }

      // The backstop cut the loop without a banner; the deferred repaint owes
      // the pane its bytes.
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(3)
      expect(warnTerminalLifecycleAnomaly).toHaveBeenCalledWith(
        'hidden output restore hit its iteration cap',
        expect.objectContaining({ ptyId: PTY_ID })
      )
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R4_MARKER, 8192))
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R4_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })
})
