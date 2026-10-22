import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'

/**
 * The list's collapsible group header. The group is the project, so it reads as a heading above its
 * 17 pt rows (20 pt semibold, as Music and Files title their groups), with the count as a quiet
 * badge, a leading repo or pin glyph and a project-group indent.
 */
export function WorkspaceSectionHeader({
  title,
  count,
  leading,
  expanded,
  pending,
  indent = 0,
  first = false,
  sidebar = false,
  onToggle
}: {
  title: string
  count: number
  leading?: ReactNode
  expanded: boolean
  /** The desktop has not answered this collapse yet. */
  pending: boolean
  indent?: number
  first?: boolean
  sidebar?: boolean
  onToggle: () => void
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${count}`}
      accessibilityState={{ expanded }}
      style={({ pressed }) => [
        styles.header,
        first && styles.first,
        { paddingLeft: (sidebar ? spacing.lg : spacing.lg + 4) + indent },
        sidebar && styles.sidebar,
        pressed && styles.pressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text style={[styles.title, sidebar && styles.titleSidebar]} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.countPill}>
        <Text style={styles.count}>{count}</Text>
      </View>
      {pending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <View style={styles.spacer} />
      <View
        style={[expanded ? styles.chevronOpen : styles.chevronClosed, slideTransition]}
        pointerEvents="none"
      >
        <ChevronDown size={18} color={colors.textSecondary} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.lg + 4,
    paddingTop: spacing.xl + 4,
    paddingBottom: spacing.xs
  },
  first: { paddingTop: spacing.md },
  sidebar: { paddingRight: spacing.lg, paddingTop: spacing.lg },
  pressed: { opacity: 0.6 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  title: {
    ...textStyles.title,
    fontSize: 20,
    lineHeight: 25,
    color: colors.textPrimary,
    flexShrink: 1
  },
  titleSidebar: { ...textStyles.headline },
  countPill: {
    minWidth: 26,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  count: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  },
  spacer: { flex: 1 },
  chevronOpen: { transform: [{ rotate: '0deg' }] },
  chevronClosed: { transform: [{ rotate: '-90deg' }] }
})
