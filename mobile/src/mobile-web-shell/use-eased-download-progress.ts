import { useEffect, useRef, useState } from 'react'
import { Animated, Easing } from 'react-native'
import { useReducedMotionEnabled } from '../onboarding/use-reduced-motion'

/** Each window reply of a concurrent batch is its own update, landing a few ms after the first. */
const BURST_WINDOW_MS = 200
const MIN_GLIDE_MS = 200
const MAX_GLIDE_MS = 2000

/**
 * The received fraction as the bar shows it: each update glides from what is on screen to the new
 * value over the average gap between bursts of updates, so the fill keeps moving until the next
 * burst lands instead of jumping and waiting. Mount is the download's start.
 */
export function useEasedDownloadProgress(fraction: number): Animated.Value {
  const shown = useRef(new Animated.Value(fraction)).current
  const [mountedAt] = useState(Date.now)
  const burstAt = useRef(mountedAt)
  const averageGapMs = useRef<number | null>(null)
  const target = useRef(fraction)
  const reduceMotion = useReducedMotionEnabled()

  useEffect(() => {
    if (fraction === target.current) {
      return
    }
    const now = Date.now()
    const sinceBurst = now - burstAt.current
    // A reply inside the current burst says nothing about when the next burst comes.
    if (averageGapMs.current === null || sinceBurst >= BURST_WINDOW_MS) {
      averageGapMs.current =
        averageGapMs.current === null ? sinceBurst : (averageGapMs.current + sinceBurst) / 2
      burstAt.current = now
    }
    target.current = fraction
    Animated.timing(shown, {
      toValue: fraction,
      duration:
        reduceMotion === true
          ? 0
          : Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, averageGapMs.current)),
      easing: Easing.linear,
      useNativeDriver: true
    }).start()
  }, [fraction, reduceMotion, shown])

  return shown
}
