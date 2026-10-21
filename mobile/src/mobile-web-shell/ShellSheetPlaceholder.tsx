import { useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { bottomDrawerStyles } from '../components/bottom-drawer-styles'
import { colors, spacing } from '../theme/mobile-theme'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { ShellDownloadProgress } from './ShellDownloadProgress'
import type { HostDisplaySource } from '../transport/use-host-display'

/**
 * The page's bottom sheet before the page can draw it: the same scrim, sheet, grabber and bottom
 * padding as `MountedBottomDrawer`, with a spinner (or the download bar) where the form will be.
 */
export function ShellSheetPlaceholder({
  animateIn,
  onEntered,
  onDismiss,
  children
}: {
  /** Slide up as a drawer opens; false when it replaces a placeholder already on screen. */
  animateIn: boolean
  onEntered: () => void
  onDismiss: () => void
  children?: ReactNode
}) {
  const insets = useSafeAreaInsets()
  const progress = useRef(new Animated.Value(animateIn ? 0 : 1)).current
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: PLACEHOLDER_ENTER_MS,
      useNativeDriver: true
    }).start(() => onEntered())
    // Once, on mount: the entrance is the drawer opening.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const sheetMotion = {
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }) }]
  }
  return (
    <View style={styles.overlay} testID="mobile-web-shell-sheet-placeholder">
      <Animated.View style={[bottomDrawerStyles.backdrop, { opacity: progress }]}>
        <Pressable style={bottomDrawerStyles.backdropPressable} onPress={onDismiss} />
      </Animated.View>
      <Animated.View
        style={[
          bottomDrawerStyles.drawer,
          styles.sheet,
          { paddingBottom: insets.bottom + spacing.lg },
          sheetMotion
        ]}
      >
        <View style={bottomDrawerStyles.handleHitArea}>
          <View style={bottomDrawerStyles.handle} />
        </View>
        <View style={styles.body}>
          {children ?? <ActivityIndicator size="small" color={colors.textSecondary} />}
        </View>
      </Animated.View>
    </View>
  )
}

/** `MountedBottomDrawer`'s SHOW_DURATION, so the placeholder opens as the real sheet does. */
const PLACEHOLDER_ENTER_MS = 180

/** The Create Workspace form's height on a phone, so the page's sheet replaces this one in place. */
const PLACEHOLDER_BODY_HEIGHT = 380

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end'
  },
  sheet: {
    width: '100%'
  },
  body: {
    height: PLACEHOLDER_BODY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  }
})

/**
 * The shell's overlay presentation: a placeholder sheet while the page cannot draw its own, and the
 * host list in place of anything an overlay must not show in a sheet (a wall, an update card).
 * `screen` is what to render instead of the shell's own state screens; `cover` stands in for the
 * page cover. Both answer `undefined` when not an overlay.
 */
export function useShellOverlay(
  enabled: boolean,
  hostId: string,
  state: MobileWebShellSessionState,
  host: HostDisplaySource | null | undefined,
  onDismiss: () => void
): { screen: ReactNode | undefined; cover: (unpainted: boolean) => ReactNode | undefined } {
  const router = useRouter()
  // Slides in once; a later placeholder (download, then opening, then painted) stands in place.
  const entered = useRef(false)
  const { kind } = state
  const fallsBack =
    enabled &&
    (kind === 'route-unavailable' || kind === 'wall' || kind === 'failed' || kind === 'offline')
  useEffect(() => {
    if (fallsBack) {
      router.replace(`/h/${encodeURIComponent(hostId)}`)
    }
  }, [fallsBack, hostId, router])
  const placeholder = (children: ReactNode) => (
    <ShellSheetPlaceholder
      animateIn={!entered.current}
      onEntered={() => {
        entered.current = true
      }}
      onDismiss={onDismiss}
    >
      {children}
    </ShellSheetPlaceholder>
  )
  if (!enabled) {
    return { screen: undefined, cover: () => undefined }
  }
  return {
    screen: fallsBack
      ? null
      : state.kind === 'ready'
        ? undefined
        : placeholder(
            state.kind === 'fetching' ? (
              <ShellDownloadProgress state={state} host={host ?? null} />
            ) : null
          ),
    cover: (unpainted) => (unpainted ? placeholder(null) : null)
  }
}
