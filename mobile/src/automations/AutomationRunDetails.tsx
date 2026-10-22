import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { getAutomationRunContent } from '../../../src/shared/automation-run-content'
import { mobileSessionRouteTarget } from '../session/mobile-session-route'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { useRouteHandoff } from '../navigation/route-handoff'
import type { RpcClient } from '../transport/rpc-client'
import { AutomationButton, AutomationMetadata } from './AutomationControls'
import { automationDate, automationRunStatusLabel } from './automation-run-presentation'
import { canOpenAutomationRunAgent } from './automation-run-agent'
import type { MobileAutomationRun } from './automation-reply-schema'
import type { AutomationRunObservation } from './use-automation-runs'
import { automationStyles as styles } from './automation-styles'

export function AutomationRunDetails(props: {
  run: MobileAutomationRun
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  connected: boolean
  history: AutomationRunObservation
  onBack: () => void
}) {
  const history = props.history
  const run = history.selected ?? props.run
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouteHandoff()
  const mounted = useRef(false)
  const epoch = useRef(0)
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    mounted.current = true
    const changed = () => {
      epoch.current++
      setOpening(false)
    }
    changed()
    const stop = props.client?.onStateChange(changed)
    return () => {
      mounted.current = false
      epoch.current++
      stop?.()
    }
  }, [props.client, props.hostId, props.executionHost])
  async function openAgent() {
    if (!props.client || opening) {
      return
    }
    setOpening(true)
    setError(null)
    const client = props.client
    const generation = client.getGeneration?.()
    const at = epoch.current
    const current = () =>
      mounted.current &&
      at === epoch.current &&
      client === latest.current.client &&
      props.hostId === latest.current.hostId &&
      props.executionHost === latest.current.executionHost &&
      generation === client.getGeneration?.() &&
      client.getState() === 'connected'
    try {
      const found = await canOpenAutomationRunAgent(client, run)
      if (!current()) {
        return
      }
      if (found === 'unverifiable') {
        setError('Could not verify the original agent pane. Reconnect and try again.')
        return
      }
      if (found !== 'available' || !run.workspaceId || !run.terminalPaneKey) {
        setError(
          'The original agent pane is no longer available to open. Saved output remains here.'
        )
        return
      }
      router.push(
        hostStackRouteHref(
          mobileSessionRouteTarget({
            hostId: props.hostId,
            worktreeId: run.workspaceId,
            paneKey: run.terminalPaneKey,
            name: run.workspaceDisplayName ?? run.title,
            executionHost: props.executionHost
          })
        )
      )
    } catch {
      if (current()) {
        setError('Could not verify the original agent pane. Reconnect and try again.')
      }
    } finally {
      if (current()) {
        setOpening(false)
      }
    }
  }
  return (
    <View style={styles.stack}>
      <AutomationButton label="All runs" onPress={props.onBack} />
      {history.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {history.error}
        </Text>
      ) : null}
      {history.unavailable ? (
        <Text style={styles.meta}>
          This run is no longer in the host’s retained history. Last saved information remains
          below.
        </Text>
      ) : null}
      <Text style={styles.title}>{run.title}</Text>
      <Text style={styles.text}>{automationRunStatusLabel(run.status)}</Text>
      <View style={styles.card}>
        <AutomationMetadata label="Scheduled for" value={automationDate(run.scheduledFor)} />
        <AutomationMetadata label="Started" value={automationDate(run.startedAt)} />
        <AutomationMetadata
          label="Trigger"
          value={run.trigger === 'manual' ? 'Run now' : 'Schedule'}
        />
        <AutomationMetadata
          label="Workspace"
          value={
            run.workspaceDisplayName ?? run.runContext?.path ?? run.workspaceId ?? 'Not created'
          }
        />
        <AutomationMetadata label="Project host" value={run.runContext?.hostId ?? 'Not recorded'} />
        <AutomationMetadata label="Run" value={run.id} />
      </View>
      {run.error ? <Text style={styles.error}>{run.error}</Text> : null}
      <Text style={styles.heading}>Output</Text>
      <Text selectable style={styles.output}>
        {getAutomationRunContent(run)}
      </Text>
      {run.outputSnapshot ? (
        <Text style={styles.meta}>
          Captured {automationDate(run.outputSnapshot.capturedAt)}
          {run.outputSnapshot.truncated ? ' · Output truncated by host' : ''}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {!run.terminalPaneKey || !run.workspaceId ? (
        <Text style={styles.meta}>
          The original agent pane is unavailable. Saved output remains here.
        </Text>
      ) : null}
      <AutomationButton
        label="Open agent"
        onPress={() => void openAgent()}
        disabled={opening || !props.connected || !run.terminalPaneKey || !run.workspaceId}
      />
    </View>
  )
}
