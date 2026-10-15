import { Switch } from 'react-native'
import { colors } from '../theme/mobile-theme'

export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

/** The app's switch: neutral track and thumb, no platform accent. */
export function MobileSwitch(props: MobileSwitchProps) {
  return (
    <Switch
      {...props}
      trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
      thumbColor={colors.textPrimary}
    />
  )
}
