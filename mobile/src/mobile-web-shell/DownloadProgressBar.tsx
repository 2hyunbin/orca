import { useEffect, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { downloadFraction, type DownloadProgressFeed } from './download-progress-feed'

/** Long enough to read as motion between replies, short enough not to trail the caption. */
const FILL_EASE_MS = 150
// Why: web has no native driver.
const useNativeDriver = Platform.OS !== 'web'

export function downloadedMegabytesCaption(receivedBytes: number, totalBytes: number): string {
  return `${megabytes(receivedBytes)} of ${megabytes(totalBytes)} MB`
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/**
 * The page bundle's download as a bar. The fill follows the feed on the native driver, so it keeps
 * moving while the JS thread is busy decoding; the byte counts are React's, for the caption and the
 * accessibility value that read them.
 */
export function DownloadProgressBar({
  feed,
  receivedBytes,
  totalBytes,
  accessibilityLabel,
  testID
}: {
  feed: DownloadProgressFeed
  receivedBytes: number
  totalBytes: number
  accessibilityLabel: string
  testID?: string
}) {
  const [fill] = useState(() => new Animated.Value(feed.current()))
  // Unknown counts as reduced, the same as LoadingSpinner.
  const reducedMotion = useReducedMotionEnabled() !== false
  useEffect(() => {
    fill.setValue(feed.current())
    let easing: Animated.CompositeAnimation | null = null
    const unsubscribe = feed.subscribe((fraction) => {
      if (reducedMotion) {
        fill.setValue(fraction)
        return
      }
      easing = Animated.timing(fill, {
        toValue: fraction,
        duration: FILL_EASE_MS,
        easing: Easing.out(Easing.quad),
        isInteraction: false,
        useNativeDriver
      })
      easing.start()
    })
    return () => {
      unsubscribe()
      easing?.stop()
    }
  }, [feed, fill, reducedMotion])
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(downloadFraction(receivedBytes, totalBytes) * 100)
      }}
      testID={testID}
    >
      <Animated.View style={[styles.fill, { transform: [{ scaleX: fill }] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    width: 180,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.textSecondary,
    transformOrigin: 'left'
  }
})
