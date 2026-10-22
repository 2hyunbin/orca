import { ChevronRight } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import {
  getActiveProviderRateLimits,
  getUsageBarState,
  hasActiveProviderUsage,
  UsageBar,
  type AccountsSnapshot,
  type ProviderKey
} from '../components/AccountUsage'
import { ListGroup, LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/ui/ListGroup'
import { SectionHeader } from '../components/ui/SectionHeader'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'

const PROVIDERS: readonly ProviderKey[] = ['claude', 'codex']
const PROVIDER_LABELS: Record<ProviderKey, string> = { claude: 'Claude', codex: 'Codex' }

/** One row per account with usage, in an inset group; each opens that desktop's Accounts screen. */
export function MobileHomeAccountUsageCards(props: {
  items: { host: HostProfile; snapshot: AccountsSnapshot }[]
  onOpen: (hostId: string) => void
}) {
  if (props.items.length === 0) {
    return null
  }
  const showHost = props.items.length > 1
  const rows = props.items.flatMap(({ host, snapshot }) =>
    PROVIDERS.flatMap((provider) => {
      const providerSnapshot = provider === 'claude' ? snapshot.claude : snapshot.codex
      const limits = getActiveProviderRateLimits(snapshot, provider)
      if (providerSnapshot.accounts.length === 0 && !hasActiveProviderUsage(limits)) {
        return []
      }
      const active =
        providerSnapshot.accounts.find(
          (account) => account.id === providerSnapshot.activeAccountId
        ) ?? null
      return [
        <UsageRow
          key={`${host.id}:${provider}`}
          provider={provider}
          email={active?.email ?? 'System default'}
          hostName={showHost ? host.name : null}
          session={getUsageBarState(limits, 'session')}
          weekly={getUsageBarState(limits, 'weekly')}
          onPress={() => props.onOpen(host.id)}
        />
      ]
    })
  )
  if (rows.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title="Account usage" />
      <ListGroup separatorInset={LIST_LEADING_INSET}>{rows}</ListGroup>
    </>
  )
}

type BarState = ReturnType<typeof getUsageBarState>

function UsageRow(props: {
  provider: ProviderKey
  email: string
  hostName: string | null
  session: BarState
  weekly: BarState
  onPress: () => void
}) {
  const label = [
    `${PROVIDER_LABELS[props.provider]} usage`,
    props.email,
    props.hostName ? `on ${props.hostName}` : null
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={props.onPress}>
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.leading}>
            {props.provider === 'claude' ? (
              <ClaudeIcon size={20} />
            ) : (
              <OpenAIIcon size={20} color={colors.textPrimary} />
            )}
          </View>
          <View style={styles.main}>
            <Text style={styles.title} numberOfLines={1}>
              {props.email}
            </Text>
            {props.hostName ? (
              <Text style={styles.host} numberOfLines={1}>
                {props.hostName}
              </Text>
            ) : null}
            <View style={styles.bars}>
              <UsageBar
                label="5h"
                usedPercent={props.session.usedPercent}
                unavailable={props.session.unavailable}
                loading={props.session.loading}
              />
              <UsageBar
                label="7d"
                usedPercent={props.weekly.usedPercent}
                unavailable={props.weekly.unavailable}
                loading={props.weekly.loading}
              />
            </View>
          </View>
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md
  },
  pressed: { backgroundColor: colors.fill },
  leading: {
    width: 28,
    height: textStyles.body.lineHeight,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center'
  },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  host: { ...textStyles.subhead, color: colors.textSecondary },
  bars: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs }
})
