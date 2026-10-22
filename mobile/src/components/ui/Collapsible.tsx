import { useEffect, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { HEIGHT_DURATION_MS, HEIGHT_EASING } from './height-motion'

type CollapsibleProps = {
  open: boolean
  children: ReactNode
}

/**
 * The body of a disclosure: it eases open to its content's height and fades in, and eases shut
 * before it unmounts. Pair it with a chevron on `slideTransition` in the row that toggles it.
 */
export function Collapsible({ open, children }: CollapsibleProps) {
  const reducedMotion = useReducedMotionEnabled()
  const [mounted, setMounted] = useState(open)
  const [contentHeight, setContentHeight] = useState(0)
  const progress = useSharedValue(open ? 1 : 0)

  useEffect(() => {
    if (open) {
      setMounted(true)
    }
    progress.value = withTiming(
      open ? 1 : 0,
      { duration: reducedMotion === true ? 0 : HEIGHT_DURATION_MS, easing: HEIGHT_EASING },
      (finished) => {
        if (finished && !open) {
          runOnJS(setMounted)(false)
        }
      }
    )
  }, [open, progress, reducedMotion])

  // Why the dependency list: the page bundle has no worklet plugin, so web mappers read only it.
  const frameStyle = useAnimatedStyle(
    () => ({ height: progress.value * contentHeight, opacity: progress.value }),
    [progress, contentHeight]
  )

  if (!mounted) {
    return null
  }
  return (
    <Animated.View style={[styles.frame, frameStyle]}>
      <View
        style={styles.content}
        onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, right: 0 }
})
