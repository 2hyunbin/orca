import { Switch } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileSwitchProps } from './MobileSwitch'

// react-native-web paints an "on" thumb with its own teal unless given activeThumbColor, a prop
// React Native's types do not declare.
const WEB_ON_THUMB = { activeThumbColor: colors.textPrimary }

/** The app's switch on the page: as native, with the web-only on-thumb color set. */
export function MobileSwitch(props: MobileSwitchProps) {
  return (
    <Switch
      {...props}
      {...WEB_ON_THUMB}
      trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
      thumbColor={colors.textPrimary}
    />
  )
}
