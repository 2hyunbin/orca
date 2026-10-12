import { Animated, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { useHostDisplay, type HostDisplaySource } from '../transport/use-host-display'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { useEasedDownloadProgress } from './use-eased-download-progress'

const DOWNLOADING_LABEL = 'Downloading the latest app'

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/** The page bundle coming down from the host, as a bar over the bytes received. */
export function ShellDownloadProgress({
  state,
  host
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'fetching' }>
  /** Null until the stored profile is read, which leaves the caption without a name. */
  host: HostDisplaySource | null
}) {
  const fraction = state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : 0
  const shown = useEasedDownloadProgress(fraction)
  const hostTitle = useHostDisplay(host).title
  const source = host === null ? '' : `from ${hostTitle} · `
  return (
    <>
      {/* The spinner's 20pt slot, so the label holds still between this and the waiting frames. */}
      <View style={styles.slot}>
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={DOWNLOADING_LABEL}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
          testID="mobile-web-shell-progress-bar"
        >
          <Animated.View style={[styles.fill, { transform: [{ scaleX: shown }] }]} />
        </View>
      </View>
      <Text style={styles.label}>{DOWNLOADING_LABEL}</Text>
      <Text style={styles.caption} testID="mobile-web-shell-progress">
        {`${source}${megabytes(state.receivedBytes)} of ${megabytes(state.totalBytes)} MB`}
      </Text>
    </>
  )
}

const styles = StyleSheet.create({
  slot: {
    height: 20,
    justifyContent: 'center'
  },
  track: {
    width: 180,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    width: '100%',
    height: '100%',
    borderRadius: 2,
    transformOrigin: 'left',
    backgroundColor: colors.textSecondary
  },
  label: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center'
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.sm,
    fontVariant: ['tabular-nums']
  }
})
