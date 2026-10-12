import { useEffect, useRef } from 'react'
import { Animated, Easing } from 'react-native'
import { useReducedMotionEnabled } from '../onboarding/use-reduced-motion'
import { nextDownloadEase, type DownloadEase } from './download-progress-easing'

/**
 * The received fraction as the bar shows it: each update glides from what is on screen to the new
 * value, never past it, over about the time bursts of updates have been taking. Mount is the start.
 */
export function useEasedDownloadProgress(fraction: number): Animated.Value {
  const shown = useRef(new Animated.Value(fraction)).current
  const target = useRef(fraction)
  const burstStartedAt = useRef<number | null>(null)
  const ease = useRef<DownloadEase | null>(null)
  const reduceMotion = useReducedMotionEnabled()

  useEffect(() => {
    const now = Date.now()
    if (burstStartedAt.current === null) {
      burstStartedAt.current = now
      return
    }
    if (fraction === target.current) {
      return
    }
    const next = nextDownloadEase(ease.current, now - burstStartedAt.current)
    ease.current = next
    if (next.newBurst) {
      burstStartedAt.current = now
    }
    // A fraction that went down would glide through values above it, so it snaps like reduced motion.
    const snap = reduceMotion === true || fraction < target.current
    target.current = fraction
    if (snap) {
      shown.stopAnimation()
      shown.setValue(fraction)
      return
    }
    Animated.timing(shown, {
      toValue: fraction,
      duration: next.durationMs,
      easing: Easing.linear,
      useNativeDriver: true
    }).start()
  }, [fraction, reduceMotion, shown])

  useEffect(() => () => shown.stopAnimation(), [shown])

  return shown
}
