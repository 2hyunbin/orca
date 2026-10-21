import { useEffect, useRef, type ReactNode } from 'react'
import { ActivityIndicator, Animated, StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { BOTTOM_DRAWER_BACKDROP_COLOR } from './bottom-drawer-constants'

/**
 * The bottom drawer's backdrop on its own: what an overlay route shows over the screen beneath
 * while its drawer cannot draw yet, in the colour that drawer's backdrop will take over at.
 */
export function OverlayScrim({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.scrim} testID="overlay-scrim">
      {children ?? <FadingSpinner />}
    </View>
  )
}

function FadingSpinner() {
  const opacity = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: SPINNER_FADE_MS,
      useNativeDriver: true
    })
    fade.start()
    return () => fade.stop()
  }, [opacity])
  return (
    <Animated.View style={{ opacity }}>
      <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading" />
    </Animated.View>
  )
}

const SPINNER_FADE_MS = 150

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BOTTOM_DRAWER_BACKDROP_COLOR
  }
})
