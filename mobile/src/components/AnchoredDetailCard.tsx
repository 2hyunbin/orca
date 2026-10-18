import { useEffect, useState } from 'react'
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type DetailCardAnchor = { x: number; y: number; width: number; height: number }

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
  onDismiss,
  onClosed,
  title,
  detail,
  footer
}: {
  anchor: DetailCardAnchor
  open: boolean
  onDismiss: () => void
  onClosed: () => void
  title: string
  detail?: string | null
  footer?: React.ReactNode
}): React.JSX.Element {
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = useReducedMotionEnabled() === false
  const window = useWindowDimensions()
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

  const width = Math.min(CARD_WIDTH, window.width - EDGE_INSET * 2)
  const left = Math.min(Math.max(anchor.x, EDGE_INSET), window.width - EDGE_INSET - width)
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
      <Animated.View
        style={[
          styles.card,
          {
            left,
            top: anchor.y + anchor.height,
            width,
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
        <Text style={styles.title} selectable>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.detail} selectable>
            {detail}
          </Text>
        ) : null}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
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
    padding: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
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
