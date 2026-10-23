// Canary self-check for the watcher child. Why: @parcel/watcher can wedge
// silently — a lock-order inversion between Debounce::notify (debounce mutex →
// watcher mutex) and Watcher teardown (watcher mutex → debounce mutex in
// ~Watcher) deadlocks the single process-wide debounce thread, after which
// every subscription still acks but no events are ever delivered. The canary
// watches a private temp dir and touches a file in it; consecutive missed
// deliveries mean event delivery is dead, so exit and let the host respawn.
//
// A missed canary can also mean the OS event source itself is stalled (an
// overloaded macOS fseventsd delays every client). A restart cannot fix that
// and recreating every stream adds load, so before exiting the canary checks
// whether an independent fs.watch on the same dir also stays silent.
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './parcel-watcher-module-loader'
import { detectShallowWatchDelivery } from './shallow-watch-delivery-probe'
import { errorMessage } from '../../shared/error-message'

const CANARY_INTERVAL_MS = 10_000
const CANARY_EVENT_TIMEOUT_MS = 5_000
const CANARY_MAX_MISSES = 2
const CANARY_NEXT_PROBE_DELAY_MS = CANARY_INTERVAL_MS - CANARY_EVENT_TIMEOUT_MS
const INDEPENDENT_PROBE_WINDOW_MS = 5_000
const INDEPENDENT_PROBE_WRITE_INTERVAL_MS = 1_000
export const CANARY_STALL_BACKOFF_INITIAL_MS = 30_000
export const CANARY_STALL_BACKOFF_MAX_MS = 5 * 60_000
// Why: inotify/ReadDirectoryChanges crawls hold Parcel's backend mutex and
// legitimately starve the canary; only a crawl this old is treated as stuck.
export const CANARY_PENDING_CRAWL_GRACE_MS = 10 * 60_000

export type WatcherCanaryActivity = {
  revision: number
  liveSubscriptions: number
  /** Start time of the in-flight native subscribe, or null when none is running. */
  pendingCrawlStartedAt: number | null
}

/** Returns the revision a probe is valid for, or null when the canary is disarmed. */
export function armedCanaryRevision(
  activity: WatcherCanaryActivity,
  now: number,
  platform: NodeJS.Platform
): number | null {
  if (activity.pendingCrawlStartedAt !== null) {
    // Why: FSEvents subscribe does not crawl, so a pending subscribe there is
    // most likely stuck behind the deadlock the canary exists to catch.
    const stuck =
      platform === 'darwin' || now - activity.pendingCrawlStartedAt >= CANARY_PENDING_CRAWL_GRACE_MS
    return stuck ? activity.revision : null
  }
  return activity.liveSubscriptions > 0 ? activity.revision : null
}

type IndependentProbeVerdict =
  | 'native-delivered'
  | 'independent-only'
  | 'silent'
  | 'unavailable'
  | 'inconclusive'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function probeIndependentDelivery(
  canaryDir: string,
  nativeDeliveredSince: (time: number) => boolean
): Promise<IndependentProbeVerdict> {
  const startedAt = Date.now()
  let independentSeen = false
  let watcherFailed = false
  let watcher: ReturnType<typeof watch>
  try {
    watcher = watch(canaryDir, { persistent: false }, () => {
      independentSeen = true
    })
    watcher.on('error', () => {
      watcherFailed = true
    })
  } catch {
    return 'unavailable'
  }
  try {
    for (
      let elapsed = 0;
      elapsed < INDEPENDENT_PROBE_WINDOW_MS;
      elapsed += INDEPENDENT_PROBE_WRITE_INTERVAL_MS
    ) {
      try {
        // Repeated writes: FSEvents streams start asynchronously and can miss the first one.
        writeFileSync(join(canaryDir, 'canary-probe.txt'), String(Date.now()))
      } catch {
        return 'inconclusive'
      }
      await sleep(INDEPENDENT_PROBE_WRITE_INTERVAL_MS)
      if (nativeDeliveredSince(startedAt)) {
        return 'native-delivered'
      }
    }
    if (independentSeen) {
      return 'independent-only'
    }
    return watcherFailed ? 'unavailable' : 'silent'
  } finally {
    try {
      watcher.close()
    } catch {
      // Probe teardown is best-effort.
    }
  }
}

export async function startWatcherDeliveryCanary(
  getActivity: () => WatcherCanaryActivity
): Promise<void> {
  const configuredCanaryDir = process.env.ORCA_WATCHER_CANARY_DIR
  let canaryDir: string
  let lastEventAt = 0
  try {
    canaryDir = configuredCanaryDir ?? mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
    const watcher = await loadParcelWatcher()
    // Why: pin the Windows backend like the main subscriptions do, so the
    // canary never probes for Watchman.
    const opts: ParcelWatcher.Options = process.platform === 'win32' ? { backend: 'windows' } : {}
    await watcher.subscribe(
      canaryDir,
      (err) => {
        if (!err) {
          lastEventAt = Date.now()
        }
      },
      opts
    )
  } catch (err) {
    process.stderr.write(`[parcel-watcher-process] canary unavailable: ${errorMessage(err)}\n`)
    return
  }
  process.on('exit', () => {
    if (configuredCanaryDir) {
      return
    }
    try {
      rmSync(canaryDir, { recursive: true, force: true })
    } catch {
      // Temp dir cleanup is best-effort.
    }
  })
  // Why: measure fs.watch while delivery is healthy; a host where fs.watch is
  // always mute cannot tell a stall from a deadlock, so it keeps restarting.
  const independentWatchWorks = Promise.resolve(detectShallowWatchDelivery()).then(
    (works) => works === true,
    () => false
  )

  let misses = 0
  let stallBackoffMs: number | null = null
  const stableRevision = (): number | null =>
    armedCanaryRevision(getActivity(), Date.now(), process.platform)
  const nextProbeDelay = (): number => stallBackoffMs ?? CANARY_NEXT_PROBE_DELAY_MS
  const schedule = (delayMs: number): void => {
    setTimeout(() => void tick(), delayMs)
  }
  const markDelivered = (): void => {
    misses = 0
    if (stallBackoffMs !== null) {
      stallBackoffMs = null
      process.stderr.write('[parcel-watcher-process] system file events recovered after stall\n')
    }
  }
  const restart = (reason: string): void => {
    process.stderr.write(
      `[parcel-watcher-process] event delivery wedged (${reason}); restarting watcher process\n`
    )
    process.exit(2)
  }

  const tick = async (): Promise<void> => {
    const activityRevision = stableRevision()
    if (activityRevision === null) {
      misses = 0
      stallBackoffMs = null
      schedule(CANARY_INTERVAL_MS)
      return
    }
    const probedAt = Date.now()
    try {
      writeFileSync(join(canaryDir, 'canary.txt'), String(probedAt))
    } catch {
      schedule(nextProbeDelay())
      return
    }
    await sleep(CANARY_EVENT_TIMEOUT_MS)
    // A root may start crawling after this probe was written. Invalidate the
    // probe instead of misclassifying lifecycle work as a delivery deadlock.
    if (stableRevision() !== activityRevision) {
      misses = 0
      schedule(nextProbeDelay())
      return
    }
    if (lastEventAt >= probedAt) {
      markDelivered()
      schedule(CANARY_NEXT_PROBE_DELAY_MS)
      return
    }
    misses++
    if (misses < CANARY_MAX_MISSES) {
      schedule(nextProbeDelay())
      return
    }
    if (!(await independentWatchWorks)) {
      restart('canary starved')
      return
    }
    const verdict = await probeIndependentDelivery(canaryDir, (time) => lastEventAt >= time)
    if (stableRevision() !== activityRevision) {
      misses = 0
      schedule(nextProbeDelay())
      return
    }
    if (verdict === 'native-delivered') {
      markDelivered()
      schedule(CANARY_NEXT_PROBE_DELAY_MS)
      return
    }
    if (verdict === 'independent-only') {
      restart('canary starved while fs.watch delivered')
      return
    }
    if (verdict === 'unavailable') {
      restart('canary starved; fs.watch probe unavailable')
      return
    }
    if (verdict === 'silent') {
      stallBackoffMs =
        stallBackoffMs === null
          ? CANARY_STALL_BACKOFF_INITIAL_MS
          : Math.min(stallBackoffMs * 2, CANARY_STALL_BACKOFF_MAX_MS)
      process.stderr.write(
        `[parcel-watcher-process] system file events stalled (canary and fs.watch probe both silent); keeping watcher process, next check in ${stallBackoffMs / 1000}s\n`
      )
    }
    schedule(nextProbeDelay())
  }

  schedule(CANARY_INTERVAL_MS)
}
