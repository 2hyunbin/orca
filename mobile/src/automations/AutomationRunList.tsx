import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileAutomationRun } from './automation-reply-schema'
import { AutomationButton } from './AutomationControls'
import type { AutomationRunObservation } from './use-automation-runs'
import {
  automationDate,
  automationRunStatusLabel,
  runMatchesOutcome
} from './automation-run-presentation'
import { automationStyles as styles } from './automation-styles'

export function AutomationRunList(props: {
  history: AutomationRunObservation
  connected: boolean
  outcome?: string
  recent?: boolean
  onSelect: (run: MobileAutomationRun) => void
}) {
  const history = props.history
  const matches = history.runs.filter((run) => runMatchesOutcome(run, props.outcome ?? 'all'))
  const visible = props.recent ? matches.slice(0, 3) : matches
  return (
    <View style={styles.stack}>
      {history.error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {history.error}
          </Text>
          <AutomationButton
            label="Retry history"
            onPress={history.reload}
            disabled={!props.connected || history.loading}
          />
        </>
      ) : null}
      {history.loading && history.runs.length === 0 ? (
        <Text style={styles.meta}>Loading runs…</Text>
      ) : null}
      {!history.loading && visible.length === 0 ? (
        <Text style={styles.meta}>
          {history.cursor
            ? 'No matching runs in the loaded history. Load more to continue.'
            : 'No matching runs yet.'}
        </Text>
      ) : null}
      {visible.map((run) => (
        <Pressable
          key={run.id}
          accessibilityRole="button"
          accessibilityLabel={`${run.title}, ${automationRunStatusLabel(run.status)}, ${automationDate(run.scheduledFor)}`}
          onPress={() => props.onSelect(run)}
          style={styles.card}
        >
          <View style={styles.row}>
            <Text style={[styles.heading, styles.grow]}>{run.title}</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </View>
          <Text style={styles.text}>{automationRunStatusLabel(run.status)}</Text>
          <Text style={styles.meta}>
            {automationDate(run.scheduledFor)} ·{' '}
            {run.trigger === 'manual' ? 'Run now' : 'Scheduled'}
          </Text>
          {run.workspaceDisplayName ? (
            <Text style={styles.meta}>{run.workspaceDisplayName}</Text>
          ) : null}
        </Pressable>
      ))}
      {!props.recent && history.cursor ? (
        <AutomationButton
          label={history.loading ? 'Loading…' : 'Load more runs'}
          onPress={history.loadMore}
          disabled={history.loading || !props.connected}
        />
      ) : null}
    </View>
  )
}
