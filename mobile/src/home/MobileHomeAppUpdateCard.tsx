import { StyleSheet, View } from 'react-native'
import { undismissedAppUpdate } from '../app-update/app-update-checker'
import {
  appUpdateChecker,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateCard } from './AppUpdateCard'
import { spacing } from '../theme/mobile-theme'

/** Last on Home, so a check that lands after first paint never moves the rows above it. */
export function MobileHomeAppUpdateCard() {
  const available = undismissedAppUpdate(useAppUpdateState())
  if (!available) {
    return null
  }
  return (
    <View style={styles.slot}>
      <AppUpdateCard
        version={available.version}
        onPress={() => openAppUpdate(available.url)}
        onDismiss={() => appUpdateChecker.dismiss(available.version)}
      />
    </View>
  )
}

const styles = StyleSheet.create({ slot: { marginTop: spacing.xl } })
