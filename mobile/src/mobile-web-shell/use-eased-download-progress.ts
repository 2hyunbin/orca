import { useEffect, useRef } from 'react'
import { Animated, Easing } from 'react-native'
import { useReducedMotionEnabled } from '../onboarding/use-reduced-motion'
import { nextDownloadEase } from './download-progress-easing'

/**
 * The received fraction as the bar shows it: each update glides from what is on screen to the new
 * value, never past it, over about the time updates have been taking. Mount is the download's start.
 */
export function useEasedDownloadProgress(fraction: number): Animated.Value {
  const shown = useRef(new Animated.Value(fraction)).current
  const target = useRef(fraction)
  const lastUpdateAt = useRef<number | null>(null)
  const averageGapMs = useRef<number | null>(null)
  const reduceMotion = useReducedMotionEnabled()

  useEffect(() => {
    const now = Date.now()
    if (lastUpdateAt.current === null) {
      lastUpdateAt.current = now
      return
    }
    if (fraction === target.current) {
      return
    }
    const ease = nextDownloadEase(averageGapMs.current, now - lastUpdateAt.current)
    averageGapMs.current = ease.averageGapMs
    lastUpdateAt.current = now
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
      duration: ease.durationMs,
      easing: Easing.linear,
      useNativeDriver: true
    }).start()
  }, [fraction, reduceMotion, shown])

  useEffect(() => () => shown.stopAnimation(), [shown])

  return shown
}
