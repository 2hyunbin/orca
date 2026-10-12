const EASE_ALPHA = 0.5
export const DOWNLOAD_EASE_MIN_MS = 200
export const DOWNLOAD_EASE_MAX_MS = 2000

export type DownloadEase = {
  /** Moving average of the gaps between distinct progress updates. */
  readonly averageGapMs: number
  readonly durationMs: number
}

/**
 * How long the bar takes to reach a new received fraction: about as long as the next update is
 * expected to take, so the fill keeps moving between updates instead of jumping and waiting. A null
 * average means this is the first update, and its gap is the wait from the download starting.
 */
export function nextDownloadEase(previousAverageGapMs: number | null, gapMs: number): DownloadEase {
  const averageGapMs =
    previousAverageGapMs === null
      ? gapMs
      : EASE_ALPHA * gapMs + (1 - EASE_ALPHA) * previousAverageGapMs
  return {
    averageGapMs,
    durationMs: Math.min(DOWNLOAD_EASE_MAX_MS, Math.max(DOWNLOAD_EASE_MIN_MS, averageGapMs))
  }
}
