import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isRecognizedAgentType } from '../../shared/agent-process-recognition'
import {
  agentMainAgentVerdict,
  agentTurnEndedOnPurpose
} from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type {
  NotificationSettings,
  LiveNotificationRetirement
} from '../../shared/notification-settings-types'
import { buildNotificationOptions } from '../ipc/notification-options'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import type { StructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'

export const HOST_HOOK_DONE_QUIET_MS = 1_500

type Deps = {
  readRow: (paneKey: string) => AgentStatusIpcPayload | null
  readNotificationSettings: () => NotificationSettings | undefined
  readWorkspaceLabels: (id: string) => StructuredAttentionWorkspaceLabels
  isWorkspaceMuted: (id: string) => boolean
  dispatch: (event: MobileNotificationDispatchEvent) => void
  retire: (alerts: readonly LiveNotificationRetirement[]) => void
  now: () => number
}

export function createTerminalAgentMobileAttention(deps: Deps) {
  const panes = new Map<
    string,
    {
      source: string
      row: AgentStatusIpcPayload
      alerts: { notificationId: string; at: number }[]
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  const forget = (key: string): void => {
    clearTimeout(panes.get(key)?.timer)
    panes.delete(key)
  }
  const observe = (change: AgentPaneChange): void => {
    if (change.kind === 'moved') {
      return
    }
    const row = deps.readRow(change.paneKey)
    if (
      !row ||
      !change.workspace ||
      row.connectionId ||
      row.structuredHost ||
      row.programStatusOnly ||
      row.providerSessionOnly ||
      !isRecognizedAgentType(row.agentType)
    ) {
      forget(change.paneKey)
      return
    }
    const worktreeId = row.worktreeId ?? change.workspace.worktreeId
    const source = JSON.stringify([
      worktreeId,
      row.terminalHandle,
      row.runId,
      row.executionId,
      row.agentType
    ])
    let pane = panes.get(change.paneKey)
    if (pane?.source !== source) {
      forget(change.paneKey)
      pane = undefined
    }
    const previous = pane?.row
    pane ??= { source, row, alerts: [] }
    panes.set(change.paneKey, pane)
    pane.row = row
    if (change.kind === 'seeded' || row.isReplay || row.restoredUnconfirmed) {
      clearTimeout(pane.timer)
      pane.alerts = []
      return
    }
    const startedAt = row.turnStartedAt
    if (
      startedAt !== undefined &&
      startedAt !== previous?.turnStartedAt &&
      (row.runId || row.executionId)
    ) {
      const retired = pane.alerts.filter((alert) => startedAt > alert.at)
      pane.alerts = pane.alerts.filter((alert) => !retired.includes(alert))
      if (retired.length) {
        deps.retire(retired)
      }
    }
    const completed = row.state === 'done' || row.turnCompletedAt !== undefined
    if (agentTurnEndedOnPurpose(row) || (row.state === 'working' && !completed)) {
      clearTimeout(pane.timer)
      return
    }
    if (
      previous &&
      row.state === previous.state &&
      row.turnCompletedAt === previous.turnCompletedAt &&
      row.stateStartedAt === previous.stateStartedAt
    ) {
      return
    }
    clearTimeout(pane.timer)
    const agentState = completed ? 'done' : row.state
    const stamp = row.turnCompletedAt ?? row.stateStartedAt
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey: change.paneKey,
      stateStartedAt: stamp
    })
    if (!notificationId || pane.alerts.some((alert) => alert.notificationId === notificationId)) {
      return
    }
    const expected = pane
    const announce = (): void => {
      if (
        panes.get(change.paneKey) !== expected ||
        expected.row.state !== row.state ||
        expected.row.turnCompletedAt !== row.turnCompletedAt ||
        deps.isWorkspaceMuted(worktreeId)
      ) {
        return
      }
      const settings = deps.readNotificationSettings()
      if (!settings) {
        return
      }
      let labels: StructuredAttentionWorkspaceLabels = {}
      try {
        labels = deps.readWorkspaceLabels(worktreeId)
      } catch {
        /* Labels do not gate news. */
      }
      const outcome = completed ? agentMainAgentVerdict(row) : null
      const { title, body } = buildNotificationOptions(
        {
          source: 'agent-task-complete',
          worktreeId,
          ...labels,
          agentState,
          agentType: row.agentType,
          agentPrompt: row.prompt,
          agentToolName: row.toolName,
          agentToolInput: row.toolInput,
          agentLastAssistantMessage: row.lastAssistantMessage,
          ...(outcome ? { agentTurnOutcome: outcome } : {})
        },
        getRuntimeDesktopSurface().translateNotification
      )
      expected.alerts = [...expected.alerts, { notificationId, at: stamp }].slice(-20)
      deps.dispatch({
        type: 'notification',
        emittedAt: deps.now(),
        source: 'agent-task-complete',
        title,
        body,
        worktreeId,
        notificationId,
        agentState,
        ...(!settings.enabled || !settings.agentTaskComplete ? { desktopAllowed: false } : {})
      })
    }
    if (completed) {
      pane.timer = setTimeout(announce, HOST_HOOK_DONE_QUIET_MS)
    } else {
      announce()
    }
  }
  return {
    observe,
    dispose: () => {
      for (const key of panes.keys()) {
        forget(key)
      }
    }
  }
}
