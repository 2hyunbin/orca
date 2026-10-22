import { StyleSheet, Text, View } from 'react-native'
import { LargeTitle } from '../components/ui/NavBar'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  const minutes = totalMinutes % 60
  return totalHours > 0 ? `${totalHours}h ${minutes}m` : `${totalMinutes}m`
}

/** The large title and a quiet row of lifetime numbers, laid out before they arrive so nothing moves. */
export function MobileHomeListHeader({ stats }: { stats: HomeStatsSummary | null }) {
  const items = [
    { label: 'Agents spawned', value: stats ? stats.totalAgentsSpawned.toLocaleString() : null },
    { label: 'Agent time', value: stats ? formatDuration(stats.totalAgentTimeMs) : null },
    { label: 'PRs created', value: stats ? stats.totalPRsCreated.toLocaleString() : null }
  ]
  return (
    <View>
      <LargeTitle title="Orca" />
      <View
        style={styles.stats}
        accessible
        accessibilityLabel={
          stats
            ? items.map((item) => `${item.label}: ${item.value}`).join(', ')
            : 'Usage numbers not loaded yet'
        }
      >
        {items.map((item) => (
          <View key={item.label} style={styles.stat}>
            <Text
              style={[styles.value, item.value === null && styles.valuePending]}
              numberOfLines={1}
            >
              {item.value ?? '—'}
            </Text>
            <Text style={styles.label} numberOfLines={1}>
              {item.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  stats: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.xs
  },
  stat: { flex: 1, minWidth: 0 },
  value: {
    ...textStyles.headline,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  valuePending: { color: colors.textMuted },
  label: { ...textStyles.footnote, color: colors.textMuted }
})
