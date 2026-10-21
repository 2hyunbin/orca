import { useState } from 'react'
import { ActivityIndicator, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { bottomDrawerStyles } from '../components/bottom-drawer-styles'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import type { ShellOverlayDownload } from '../mobile-web-shell/shell-overlay-load'
import { colors, spacing, typography } from '../theme/mobile-theme'

const CANCEL_DRAG_DISTANCE = 40

/**
 * A short drawer at the bottom while the page's Create Workspace drawer loads, in the shared
 * drawer chrome: a spinner, or the download while there is one. The page's drawer slides up in
 * its place. Nothing dims the screen above; a tap there or a drag down cancels.
 */
export function NewWorkspaceLoadingDrawer({
  download,
  onCancel
}: {
  download: ShellOverlayDownload | null
  onCancel: () => void
}) {
  const insets = useWindowSafeAreaInsets()
  const { isWideLayout, modalMaxWidth } = useResponsiveLayout()
  const [dragToCancel] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > CANCEL_DRAG_DISTANCE) {
          onCancel()
        }
      }
    })
  )
  return (
    <View style={StyleSheet.absoluteFill} testID="new-workspace-loading-drawer">
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancel" />
      <View
        style={[
          bottomDrawerStyles.anchor,
          isWideLayout && bottomDrawerStyles.anchorWide,
          { paddingLeft: insets.left, paddingRight: insets.right }
        ]}
        pointerEvents="box-none"
      >
        <View
          style={[
            bottomDrawerStyles.drawer,
            {
              width: '100%',
              maxWidth: isWideLayout ? modalMaxWidth : undefined,
              paddingBottom: insets.bottom + spacing.lg
            }
          ]}
          {...dragToCancel.panHandlers}
        >
          <View style={bottomDrawerStyles.handleHitArea}>
            <View style={bottomDrawerStyles.handle} />
          </View>
          <View style={styles.body}>
            {download === null ? (
              <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading" />
            ) : (
              <DownloadProgress download={download} />
            )}
          </View>
        </View>
      </View>
    </View>
  )
}

function DownloadProgress({ download }: { download: ShellOverlayDownload }) {
  const fraction =
    download.totalBytes > 0 ? Math.min(1, download.receivedBytes / download.totalBytes) : 0
  return (
    <>
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
    </>
  )
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

const styles = StyleSheet.create({
  body: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
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
