import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion } from '../../theme/mobile-theme'
import { pressTransition } from './transition-styles'

type IconButtonVariant = 'filled' | 'primary' | 'bare'

type IconButtonProps = {
  icon: LucideIcon
  accessibilityLabel: string
  onPress: () => void
  variant?: IconButtonVariant
  iconSize?: number
  /** Replaces the icon's colour, e.g. a muted glyph or a status tone. */
  iconColor?: string
  disabled?: boolean
  selected?: boolean
  testID?: string
  style?: StyleProp<ViewStyle>
}

const CIRCLE = 36

/** A 44 pt touch box around a 36 pt circle; the soft fill is what makes an icon read as a button. */
export function IconButton({
  icon: Icon,
  accessibilityLabel,
  onPress,
  variant = 'filled',
  iconSize = 20,
  iconColor,
  disabled = false,
  selected,
  testID,
  style
}: IconButtonProps) {
  const fill =
    variant === 'primary' ? colors.primary : variant === 'filled' ? colors.fill : 'transparent'
  const pressedFill =
    variant === 'primary'
      ? colors.primaryPressed
      : variant === 'filled'
        ? colors.fillPressed
        : colors.fill
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      testID={testID}
      style={[styles.touch, disabled && styles.disabled, style]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.circle,
            { backgroundColor: pressed ? pressedFill : fill },
            pressed ? styles.pressed : null,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <Icon
            size={iconSize}
            color={iconColor ?? (variant === 'primary' ? colors.onPrimary : colors.textPrimary)}
            strokeWidth={2.2}
          />
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disabled: { opacity: motion.disabledOpacity },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { transform: [{ scale: motion.pressedIconScale }] }
})
