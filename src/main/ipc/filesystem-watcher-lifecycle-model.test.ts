// Randomized model test for local watcher listener bookkeeping across watch churn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcherSender } from './filesystem-watcher-test-sender'

const { handleMock, statMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import {
  closeLocalWatcherForWorktreePath,
  forgetLocalWatcherRemovalSnapshot,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import {
  resetWatcherChildRegistryForTest,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'

type Handler = (event: unknown, args: unknown) => unknown
type Sender = ReturnType<typeof createWatcherSender> & { destroyed: boolean }
type SubscribeOutcome = 'ok' | 'capacity'

const ROOTS = ['/repo', '/other']
const OUTCOMES: SubscribeOutcome[] = ['ok', 'ok', 'ok', 'capacity']
// Why: CI keeps this quick; raise ORCA_WATCH_MODEL_RUNS locally for deeper searches.
const RUNS = Number(process.env.ORCA_WATCH_MODEL_RUNS ?? 1000)
const MIN_STEPS = 20
const MAX_STEPS = 60
const GRACE_PLUS_MS = 31_000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rootKey(worktreePath: string): string {
  return getLocalWatcherRoot(worktreePath).key
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve()
  }
  await vi.advanceTimersByTimeAsync(0)
}

describe('local watcher lifecycle (randomized model)', () => {
  const handlers: Record<string, Handler> = {}
  const deferred: (() => void)[] = []
  let liveSubscriptions = 0
  let nextOutcome: () => { outcome: SubscribeOutcome; defer: boolean }
  let trace: string[] = []

  async function resolveAllDeferred(): Promise<void> {
    while (deferred.length > 0) {
      deferred.shift()!()
      await settle()
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetWatcherChildRegistryForTest()
    handleMock.mockImplementation((channel: string, handler: Handler) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockImplementation(async (dir: string) => {
      const { outcome, defer } = nextOutcome()
      trace.push(`  subscribe ${dir}: ${defer ? 'deferred ' : ''}${outcome}`)
      if (defer) {
        await new Promise<void>((resolve) => deferred.push(resolve))
      }
      if (outcome === 'capacity') {
        throw new WatcherChildCapacityError()
      }
      liveSubscriptions += 1
      let unsubscribed = false
      return {
        unsubscribe: vi.fn(async () => {
          if (unsubscribed) {
            throw new Error('double unsubscribe')
          }
          unsubscribed = true
          liveSubscriptions -= 1
        })
      }
    })
    deferred.length = 0
    liveSubscriptions = 0
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await resolveAllDeferred()
    await closeAllWatchers()
    resetWatcherChildRegistryForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function runModel(seed: number, steps: number): Promise<string | null> {
    const rand = mulberry32(seed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]
    nextOutcome = () => ({ outcome: pick(OUTCOMES), defer: rand() < 0.5 })
    deferred.length = 0
    liveSubscriptions = 0
    let nextSenderId = 1
    const makeSender = (): Sender => {
      const sender = Object.assign(createWatcherSender(nextSenderId++), {
        destroyed: false
      })
      sender.isDestroyed = () => sender.destroyed
      return sender
    }
    const senders: Sender[] = [makeSender(), makeSender(), makeSender()]
    // Last op per sender+root: true = watching, false = unwatched; missing = never asked.
    const wanted = new Map<string, boolean>()
    const want = (senderId: number, key: string): string => `${senderId}|${key}`
    trace = []
    const inFlight: Promise<unknown>[] = []
    const failed = (message: string): string => `${message}\n${trace.join('\n')}`

    const drain = async (): Promise<void> => {
      await resolveAllDeferred()
      await Promise.allSettled(inFlight)
      inFlight.length = 0
      await settle()
    }

    const checkListeners = (phase: string): string | null => {
      for (const [key, root] of watcherLifecycleState.watchedRoots) {
        for (const senderId of root.listeners.keys()) {
          if (wanted.get(want(senderId, key)) !== true) {
            return `${phase}: sender ${senderId} still listens on ${key} after unwatch`
          }
        }
      }
      for (const [key, retry] of watcherLifecycleState.pendingLocalCapacityRetries) {
        for (const senderId of retry.listeners.keys()) {
          if (wanted.get(want(senderId, key)) !== true) {
            return `${phase}: capacity retry for ${key} keeps unwatched sender ${senderId}`
          }
        }
      }
      return null
    }

    for (let step = 0; step < steps; step += 1) {
      const roll = rand()
      const sender = pick(senders.filter((candidate) => !candidate.destroyed))
      const worktreePath = pick(ROOTS)
      const key = rootKey(worktreePath)
      if (roll < 0.4) {
        trace.push(`watch s${sender.id} ${worktreePath}`)
        wanted.set(want(sender.id, key), true)
        inFlight.push(Promise.resolve(handlers['fs:watchWorktree']({ sender }, { worktreePath })))
      } else if (roll < 0.65) {
        trace.push(`unwatch s${sender.id} ${worktreePath}`)
        wanted.set(want(sender.id, key), false)
        handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      } else if (roll < 0.8 && deferred.length > 0) {
        trace.push('resolve-subscribe')
        deferred.splice(Math.floor(rand() * deferred.length), 1)[0]()
      } else if (roll < 0.86) {
        trace.push('grace-elapses')
        await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
      } else if (roll < 0.93) {
        const restore = rand() < 0.5
        trace.push(`remove ${worktreePath} (${restore ? 'fails, restore' : 'succeeds'})`)
        await drain()
        await closeLocalWatcherForWorktreePath(worktreePath)
        if (restore) {
          // Why not awaited: the restore re-subscribes, which may itself be a deferred install.
          inFlight.push(restoreLocalWatcherAfterFailedRemoval(worktreePath))
        } else {
          forgetLocalWatcherRemovalSnapshot(worktreePath)
          // The renderer drops the deleted workspace's watches.
          for (const owner of senders.filter((candidate) => !candidate.destroyed)) {
            if (wanted.has(want(owner.id, key))) {
              wanted.set(want(owner.id, key), false)
              handlers['fs:unwatchWorktree']({ sender: owner }, { worktreePath })
            }
          }
        }
      } else if (roll < 0.97) {
        trace.push(`window s${sender.id} closes`)
        sender.destroyed = true
        for (const [event, callback] of sender.once.mock.calls) {
          if (event === 'destroyed') {
            callback()
          }
        }
        for (const entry of wanted.keys()) {
          if (entry.startsWith(`${sender.id}|`)) {
            wanted.set(entry, false)
          }
        }
        senders.push(makeSender())
      }
      await settle()
      const stepFailure = checkListeners(`step ${step}`)
      if (stepFailure && deferred.length === 0) {
        return failed(stepFailure)
      }
    }

    await drain()
    const quiescent = checkListeners('quiescent')
    if (quiescent) {
      return failed(quiescent)
    }
    for (const key of watcherLifecycleState.watchedRoots.keys()) {
      if (watcherLifecycleState.inFlightLocalInstalls.has(key)) {
        return failed(`root ${key} is installed and still installing`)
      }
    }
    if (liveSubscriptions !== watcherLifecycleState.watchedRoots.size) {
      return failed(
        `${liveSubscriptions} native subscriptions for ${watcherLifecycleState.watchedRoots.size} roots`
      )
    }
    for (const [entry, isWanted] of wanted) {
      const [senderIdText, key] = entry.split('|')
      const senderId = Number(senderIdText)
      const listening = watcherLifecycleState.watchedRoots.get(key)?.listeners.has(senderId)
      const capacityWaiting = watcherLifecycleState.pendingLocalCapacityRetries
        .get(key)
        ?.listeners.has(senderId)
      if (isWanted && !listening && !capacityWaiting) {
        return failed(`wanted ${entry} is neither delivered nor waiting`)
      }
    }

    // Unwatching everything and waiting out the grace leaves no roots or native handles.
    for (const sender of senders.filter((candidate) => !candidate.destroyed)) {
      for (const worktreePath of ROOTS) {
        wanted.set(want(sender.id, rootKey(worktreePath)), false)
        handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      }
    }
    await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
    await settle()
    const leaked = {
      watchedRoots: watcherLifecycleState.watchedRoots.size,
      pendingTeardowns: watcherLifecycleState.pendingTeardowns.size,
      inFlightInstalls: watcherLifecycleState.inFlightLocalInstalls.size,
      pendingInstalls: watcherLifecycleState.pendingLocalInstallPromises.size,
      capacityRetries: watcherLifecycleState.pendingLocalCapacityRetries.size,
      suspended: watcherLifecycleState.suspendedLocalWatcherListeners.size,
      liveSubscriptions
    }
    if (Object.values(leaked).some((count) => count !== 0)) {
      return failed(`leaked after full unwatch: ${JSON.stringify(leaked)}`)
    }
    return null
  }

  it('drops a re-watch that was unwatched while waiting out a cancelled install', async () => {
    nextOutcome = () => ({ outcome: 'ok', defer: true })
    const sender = createWatcherSender(1)
    const args = { worktreePath: '/repo' }
    const first = handlers['fs:watchWorktree']({ sender }, args)
    await settle()
    handlers['fs:unwatchWorktree']({ sender }, args)
    const second = handlers['fs:watchWorktree']({ sender }, args)
    await settle()
    handlers['fs:unwatchWorktree']({ sender }, args)
    await resolveAllDeferred()
    await Promise.all([first, second])
    await settle()

    expect(watcherLifecycleState.watchedRoots.get(rootKey('/repo'))?.listeners.has(1)).not.toBe(
      true
    )
    await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
    expect(liveSubscriptions).toBe(0)
  })

  it('drops a window that unwatches while an earlier window is restored after a failed removal', async () => {
    nextOutcome = () => ({ outcome: 'ok', defer: false })
    const first = createWatcherSender(1)
    const second = createWatcherSender(2)
    const args = { worktreePath: '/repo' }
    await handlers['fs:watchWorktree']({ sender: first }, args)
    await handlers['fs:watchWorktree']({ sender: second }, args)
    await closeLocalWatcherForWorktreePath('/repo')

    nextOutcome = () => ({ outcome: 'ok', defer: true })
    const restoring = restoreLocalWatcherAfterFailedRemoval('/repo')
    await settle()
    handlers['fs:unwatchWorktree']({ sender: second }, args)
    await resolveAllDeferred()
    await restoring

    const listeners = watcherLifecycleState.watchedRoots.get(rootKey('/repo'))?.listeners
    expect([...(listeners?.keys() ?? [])]).toEqual([1])
    expect(watcherLifecycleState.suspendedLocalWatcherListeners.size).toBe(0)
  })

  it('never leaks listeners, roots or native subscriptions across random watch histories', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 7_000_000 + run
      const failure = await runModel(seed, MIN_STEPS + (seed % (MAX_STEPS - MIN_STEPS + 1)))
      if (failure) {
        expect(`seed ${seed}: ${failure}`).toBeNull()
      }
      await resolveAllDeferred()
      await closeAllWatchers()
      await settle()
    }
  }, 600_000)
})
