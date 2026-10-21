import { createContext, useContext, type ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { colors, spacing } from '../theme/mobile-theme'

/**
 * Drawers rendered as the body of a container that is already a sheet (the native drawer route
 * hosting the page): each shown drawer fills the container in place of an animated overlay.
 */
const InlineDrawerPresentationContext = createContext(false)

export function InlineDrawerPresentation({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  // The keyboard covers the container like any screen's; the body ends above it or the nav bar.
  const keyboard = Math.max(0, useKeyboardOcclusion())
  return (
    <InlineDrawerPresentationContext.Provider value>
      <View style={[styles.root, { paddingBottom: Math.max(insets.bottom, keyboard) }]}>
        <View style={styles.frame}>{children}</View>
      </View>
    </InlineDrawerPresentationContext.Provider>
  )
}

export function useInlineDrawerPresentation(): boolean {
  return useContext(InlineDrawerPresentationContext)
}

export function InlineDrawerBody({
  fillAvailable,
  children
}: {
  fillAvailable?: boolean
  children: ReactNode
}) {
  if (fillAvailable) {
    return <View style={styles.body}>{children}</View>
  }
  return (
    <ScrollView
      style={styles.body}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgBase },
  frame: { flex: 1 },
  // Stacked like the drawers it replaces: a picker shown over the form covers it.
  body: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.md
  },
  scrollContent: { paddingTop: spacing.md, paddingBottom: spacing.xl }
})
