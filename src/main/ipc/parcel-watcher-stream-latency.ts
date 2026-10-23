import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions,
  type ParcelWatcherIgnoreOptions
} from './filesystem-watcher-ignore'

// FSEvents stream latency, in seconds, for Orca's native watcher subscriptions.
// Why: the upstream 1 ms latency makes fseventsd flush almost per event; coarser latency let it
// coalesce and cut its CPU attributable to a busy stream by ~69% in an A/B. Without NoDefer,
// delivery happens `latency` after the first event of a burst, so this is pure added delay.
// Only Orca's patched macOS build reads it; prebuilds and non-FSEvents backends ignore it.

/** Editor and explorer roots feed the "changed on disk" path, so stay well under a second. */
export const INTERACTIVE_WATCH_LATENCY_SECONDS = 0.25

/** Git metadata streams drive coarse sidebar refreshes that already tolerate polling cadence. */
export const GIT_METADATA_WATCH_LATENCY_SECONDS = 0.5

/** The canary's 5 s delivery deadline leaves ample room. */
export const CANARY_WATCH_LATENCY_SECONDS = 1

/** Ignore set plus latency for editor/explorer roots, local and runtime alike. */
export function interactiveRootWatchOptions(): ParcelWatcherIgnoreOptions & { latency: number } {
  return {
    ...buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS),
    latency: INTERACTIVE_WATCH_LATENCY_SECONDS
  }
}
