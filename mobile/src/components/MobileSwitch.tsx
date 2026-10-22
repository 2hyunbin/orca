import { Switch } from 'react-native'
import { colors } from '../theme/mobile-theme'

export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

// react-native-web paints an "on" thumb with its own teal unless given activeThumbColor, a prop
// React Native's types do not declare.
const ON_THUMB = { activeThumbColor: '#ffffff' }

/** The app's switch: a visible translucent track when off, the accent when on, a white thumb. */
export function MobileSwitch(props: MobileSwitchProps) {
  return (
    <Switch
      {...props}
      {...ON_THUMB}
      trackColor={{ false: colors.switchTrackOff, true: colors.accentBlue }}
      ios_backgroundColor={colors.switchTrackOff}
      thumbColor="#ffffff"
    />
  )
}
