import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_EASE_MAX_MS,
  DOWNLOAD_EASE_MIN_MS,
  nextDownloadEase
} from './download-progress-easing'

const ease = (averageGapMs: number, durationMs = averageGapMs) => ({ averageGapMs, durationMs })

describe('nextDownloadEase', () => {
  it('takes the first gap as it is, however short', () => {
    expect(nextDownloadEase(null, 600)).toEqual({ ...ease(600), newBurst: true })
    expect(nextDownloadEase(null, 20)).toEqual({
      ...ease(20, DOWNLOAD_EASE_MIN_MS),
      newBurst: true
    })
  })

  it('weighs a new burst gap equally with the running average', () => {
    expect(nextDownloadEase(ease(600), 200)).toEqual({ ...ease(400), newBurst: true })
    expect(nextDownloadEase(ease(400), 1000)).toEqual({ ...ease(700), newBurst: true })
  })

  it('keeps the ease for an update inside the current burst', () => {
    expect(nextDownloadEase(ease(1600), 5)).toEqual({ ...ease(1600), newBurst: false })
    expect(nextDownloadEase(ease(1600), DOWNLOAD_EASE_MIN_MS - 1).newBurst).toBe(false)
    expect(nextDownloadEase(ease(1600), DOWNLOAD_EASE_MIN_MS).newBurst).toBe(true)
  })

  it('clamps the duration but keeps the true average for the next burst', () => {
    const slow = nextDownloadEase(ease(4000, DOWNLOAD_EASE_MAX_MS), 6000)
    expect(slow).toEqual({ ...ease(5000, DOWNLOAD_EASE_MAX_MS), newBurst: true })
    expect(nextDownloadEase(slow, 1000).durationMs).toBe(DOWNLOAD_EASE_MAX_MS)
  })
})
