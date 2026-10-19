import { useEffect, useState } from 'react'
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutRectangle
} from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { useBackClaim } from '../navigation/use-back-claim'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type DetailCardAnchor = { trigger: LayoutRectangle; top: number }

// Desktop's tab hover card: 256pt wide, under its anchor's left edge, 150ms ease-out entrance.
const CARD_WIDTH = 256
const EDGE_INSET = spacing.sm
const TRANSITION_MS = 150
const SLIDE_FROM = -6

/** Desktop's tab hover card for touch: a tap opens it under the anchor and any tap outside
 *  closes it. The caller keeps it mounted until `onClosed` so the exit can animate. */
export function AnchoredDetailCard({
  anchor,
  open,
  onTriggerPress,
  onDismiss,
  onClosed,
  title,
  detail,
  footer
}: {
  anchor: DetailCardAnchor
  open: boolean
  onTriggerPress: () => void
  onDismiss: () => void
  onClosed: () => void
  title: string
  detail?: string | null
  footer?: React.ReactNode
}): React.JSX.Element {
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = useReducedMotionEnabled() === false
  const window = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  useBackClaim(() => {
    onDismiss()
    return true
  })
  const [progress] = useState(() => new Animated.Value(0))
  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start(({ finished }) => {
      if (finished && !open) {
        onClosed()
      }
    })
    return () => animation.stop()
  }, [open, progress, onClosed])

  const width = Math.max(
    0,
    Math.min(CARD_WIDTH, window.width - insets.left - insets.right - EDGE_INSET * 2)
  )
  const left = Math.min(
    Math.max(anchor.trigger.x, insets.left + EDGE_INSET),
    window.width - insets.right - EDGE_INSET - width
  )
  const top = anchor.top
  const maxHeight = Math.max(0, window.height - top - insets.bottom - EDGE_INSET)
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={onDismiss}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close details"
      />
      {/* The Modal owns title taps until its exit finishes. */}
      <Pressable
        accessible={false}
        tabIndex={-1}
        onPress={onTriggerPress}
        style={{
          position: 'absolute',
          left: anchor.trigger.x,
          top: anchor.trigger.y,
          width: anchor.trigger.width,
          height: anchor.trigger.height
        }}
      />
      <Animated.View
        style={[
          styles.card,
          {
            left,
            top,
            width,
            maxHeight,
            opacity: progress,
            transform: slide
              ? [
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [SLIDE_FROM, 0]
                    })
                  }
                ]
              : []
          }
        ]}
      >
        <ScrollView contentContainerStyle={styles.content} tabIndex={0}>
          <Text style={styles.title} selectable>
            {title}
          </Text>
          {detail ? (
            <Text style={styles.detail} selectable>
              {detail}
            </Text>
          ) : null}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  content: { padding: spacing.md },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  detail: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm
  }
})
