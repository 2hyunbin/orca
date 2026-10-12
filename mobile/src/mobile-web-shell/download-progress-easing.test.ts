import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_EASE_MAX_MS,
  DOWNLOAD_EASE_MIN_MS,
  nextDownloadEase
} from './download-progress-easing'

describe('nextDownloadEase', () => {
  it('takes the first gap as it is', () => {
    expect(nextDownloadEase(null, 600)).toEqual({ averageGapMs: 600, durationMs: 600 })
  })

  it('weighs a new gap equally with the running average', () => {
    expect(nextDownloadEase(600, 200)).toEqual({ averageGapMs: 400, durationMs: 400 })
    expect(nextDownloadEase(400, 1000)).toEqual({ averageGapMs: 700, durationMs: 700 })
  })

  it('clamps the duration but keeps the true average for the next update', () => {
    const fast = nextDownloadEase(null, 20)
    expect(fast).toEqual({ averageGapMs: 20, durationMs: DOWNLOAD_EASE_MIN_MS })
    const slow = nextDownloadEase(4000, 6000)
    expect(slow).toEqual({ averageGapMs: 5000, durationMs: DOWNLOAD_EASE_MAX_MS })
    expect(nextDownloadEase(slow.averageGapMs, 0).durationMs).toBe(DOWNLOAD_EASE_MAX_MS)
  })
})
