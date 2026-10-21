import { useEffect, useState } from 'react'
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { BOTTOM_DRAWER_BACKDROP_COLOR } from './bottom-drawer-constants'

export type OverlayDownload = { receivedBytes: number; totalBytes: number }

/**
 * The bottom drawer's backdrop on its own: what an overlay route shows over the screen beneath
 * while its drawer cannot draw yet, in the colour that drawer's backdrop will take over at.
 */
export function OverlayScrim() {
  return <View style={styles.scrim} pointerEvents="none" testID="overlay-scrim" />
}

/**
 * That scrim for the whole of an overlay's load, mounted once so nothing restarts between its
 * stages: a card fades in once, with the download's bar while there is one and a spinner otherwise.
 * A tap on the scrim leaves, as a tap on a drawer's backdrop does.
 */
export function OverlayLoadingLayer({
  download,
  onDismiss
}: {
  download: OverlayDownload | null
  onDismiss: () => void
}) {
  const [opacity] = useState(() => new Animated.Value(0))
  useEffect(() => {
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: CARD_FADE_MS,
      useNativeDriver: true
    })
    fade.start()
    return () => fade.stop()
  }, [opacity])
  return (
    <Pressable
      style={styles.scrim}
      onPress={onDismiss}
      accessibilityLabel="Cancel"
      testID="overlay-loading-layer"
    >
      <Animated.View style={[styles.card, { opacity }]}>
        {download === null ? (
          <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading" />
        ) : (
          <DownloadProgress download={download} />
        )}
      </Animated.View>
    </Pressable>
  )
}

function DownloadProgress({ download }: { download: OverlayDownload }) {
  const fraction =
    download.totalBytes > 0 ? Math.min(1, download.receivedBytes / download.totalBytes) : 0
  return (
    <View style={styles.download}>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel="Downloading"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      >
        <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
      </View>
      <Text style={styles.caption}>
        Downloading… {megabytes(download.receivedBytes)} of {megabytes(download.totalBytes)} MB
      </Text>
    </View>
  )
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

const CARD_FADE_MS = 150

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BOTTOM_DRAWER_BACKDROP_COLOR
  },
  card: {
    minWidth: 56,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  download: {
    alignItems: 'center',
    gap: spacing.sm
  },
  track: {
    width: 180,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    height: '100%',
    backgroundColor: colors.textSecondary
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
})
