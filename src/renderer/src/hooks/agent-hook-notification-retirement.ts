import type { LiveNotificationRetirement } from '../../../shared/notification-settings-types'
import type { AgentCompletionStatusSnapshot } from '../components/terminal-pane/agent-completion-coordinator-types'
import { selectHookNotificationTimestamp } from '../components/terminal-pane/agent-completion-notification-controller'

type HookObservation = {
  seedHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  observeHookStatus: (payload: AgentCompletionStatusSnapshot) => void
  dispose: () => void
  resetCompletionState?: (options?: { requireFreshWorking?: boolean }) => void
}

export function createAgentHookNotificationRetirement(
  getPtyId: () => string | null,
  retire: (alerts: LiveNotificationRetirement[]) => void
) {
  let owed: { alert: LiveNotificationRetirement; source: string; at: number }[] = []
  let source = ''
  let lastStartedAt: number | undefined
  const sourceFor = (payload: AgentCompletionStatusSnapshot): string =>
    payload.runId || payload.executionId
      ? JSON.stringify([
          getPtyId(),
          payload.connectionId,
          payload.terminalHandle,
          payload.runId,
          payload.executionId,
          payload.authorityRestartId,
          payload.agentType
        ])
      : ''
  const retirement = {
    accepts: (payload: AgentCompletionStatusSnapshot | undefined): boolean =>
      !payload || sourceFor(payload) === source,
    record: (
      alert: LiveNotificationRetirement | undefined,
      payload: AgentCompletionStatusSnapshot | undefined
    ): void => {
      const at = payload ? selectHookNotificationTimestamp(payload) : undefined
      if (alert && source && at !== undefined && Number.isFinite(at)) {
        owed = [...owed, { alert, source, at }].slice(-20)
      }
    },
    observe: (payload: AgentCompletionStatusSnapshot): void => {
      const nextSource = sourceFor(payload)
      if (!nextSource || source !== nextSource || payload.isReplay || payload.restoredUnconfirmed) {
        owed = []
        lastStartedAt = payload.turnStartedAt
      }
      source = nextSource
      const newStart =
        payload.state === 'working' &&
        payload.turnStartedAt !== undefined &&
        Number.isFinite(payload.turnStartedAt) &&
        payload.turnStartedAt !== lastStartedAt
      lastStartedAt = payload.turnStartedAt ?? lastStartedAt
      const retired = owed.filter(
        (item) =>
          newStart &&
          item.source === source &&
          payload.turnStartedAt !== undefined &&
          payload.turnStartedAt > item.at
      )
      owed = owed.filter((item) => !retired.includes(item))
      if (retired.length) {
        retire(retired.map((item) => item.alert))
      }
    },
    clear: (): void => {
      owed = []
      source = ''
      lastStartedAt = undefined
    },
    wrapCoordinator: <T extends HookObservation>(coordinator: T): T => ({
      ...coordinator,
      ...(coordinator.resetCompletionState
        ? {
            resetCompletionState: (options?: { requireFreshWorking?: boolean }) => {
              retirement.clear()
              coordinator.resetCompletionState?.(options)
            }
          }
        : {}),
      seedHookStatus: (payload: AgentCompletionStatusSnapshot) => {
        retirement.clear()
        coordinator.seedHookStatus(payload)
      },
      observeHookStatus: (payload: AgentCompletionStatusSnapshot) => {
        retirement.observe(payload)
        coordinator.observeHookStatus(payload)
      },
      dispose: () => {
        retirement.clear()
        coordinator.dispose()
      }
    })
  }
  return retirement
}
