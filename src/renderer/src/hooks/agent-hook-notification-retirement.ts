import type { LiveNotificationRetirement } from '../../../shared/notification-settings-types'
import type {
  AgentCompletionCoordinator,
  AgentCompletionStatusSnapshot
} from '@/components/terminal-pane/agent-completion-coordinator-types'

export function createAgentHookNotificationRetirement(getPtyId: () => string | null) {
  let owed: { alert: LiveNotificationRetirement; source: string; at: number }[] = []
  let source = ''
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
      if (alert && source && payload?.stateStartedAt !== undefined) {
        owed = [...owed, { alert, source, at: payload.stateStartedAt }].slice(-20)
      }
    },
    observe: (payload: AgentCompletionStatusSnapshot): void => {
      const nextSource = sourceFor(payload)
      if (!nextSource || source !== nextSource || payload.isReplay || payload.restoredUnconfirmed) {
        owed = []
      }
      source = nextSource
      const retired = owed.filter(
        (item) =>
          item.source === source &&
          payload.turnStartedAt !== undefined &&
          payload.turnStartedAt > item.at
      )
      owed = owed.filter((item) => !retired.includes(item))
      if (retired.length) {
        void window.api?.notifications
          ?.dismiss?.(
            [],
            [],
            undefined,
            retired.map((item) => item.alert)
          )
          .catch((error: unknown) =>
            console.warn('[agent-hook-completion] turn retirement failed', error)
          )
      }
    },
    clear: (): void => {
      owed = []
      source = ''
    },
    wrapCoordinator: (coordinator: AgentCompletionCoordinator): AgentCompletionCoordinator => ({
      ...coordinator,
      seedHookStatus: (payload) => {
        retirement.clear()
        coordinator.seedHookStatus(payload)
      },
      observeHookStatus: (payload) => {
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
