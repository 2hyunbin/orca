const EASE_ALPHA = 0.5
export const DOWNLOAD_EASE_MIN_MS = 200
export const DOWNLOAD_EASE_MAX_MS = 2000
/** Replies to one batch of concurrent reads land a few ms apart, each as its own update. */
const BURST_WINDOW_MS = DOWNLOAD_EASE_MIN_MS

export type DownloadEase = {
  /** Moving average of the gaps between bursts of progress updates. */
  readonly averageGapMs: number
  readonly durationMs: number
}

/**
 * How long the bar takes to reach a new received fraction: about as long as the next burst is
 * expected to take, so the fill keeps moving between bursts instead of jumping and waiting.
 * `previous` is null on the first update, whose gap is the wait from the download starting. An
 * update within the burst window of the current burst's start retargets with the same ease, since
 * its tiny gap says nothing about when the next burst comes.
 */
export function nextDownloadEase(
  previous: DownloadEase | null,
  gapSinceBurstStartMs: number
): DownloadEase & { readonly newBurst: boolean } {
  if (previous !== null && gapSinceBurstStartMs < BURST_WINDOW_MS) {
    return { ...previous, newBurst: false }
  }
  const averageGapMs =
    previous === null
      ? gapSinceBurstStartMs
      : EASE_ALPHA * gapSinceBurstStartMs + (1 - EASE_ALPHA) * previous.averageGapMs
  return {
    averageGapMs,
    durationMs: Math.min(DOWNLOAD_EASE_MAX_MS, Math.max(DOWNLOAD_EASE_MIN_MS, averageGapMs)),
    newBurst: true
  }
}
