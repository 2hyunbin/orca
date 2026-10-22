// The host sends terminal news while no window owns delivery.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { createHookOnlyCompletionObserver } from '../../renderer/src/components/terminal-pane/agent-completion-hook-observer'
import { selectHookNotificationTimestamp } from '../../renderer/src/components/terminal-pane/agent-completion-notification-controller'
import type { AgentCompletionStatusSnapshot } from '../../renderer/src/components/terminal-pane/agent-completion-coordinator-types'
import { createAgentHookNotificationRetirement } from '../../renderer/src/hooks/agent-hook-notification-retirement'
import {
  agentMainAgentVerdict,
  agentTurnEndedOnPurpose
} from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type {
  LiveNotificationRetirement,
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'

export type TerminalAgentWorkspaceLabels = { repoLabel?: string; worktreeLabel?: string }

type PaneNews = {
  worktreeId: string
  source: string
  observer: ReturnType<typeof createHookOnlyCompletionObserver>
  retirement: ReturnType<typeof createAgentHookNotificationRetirement>
}

export type TerminalAgentPhonePushDeps = {
  /** A desktop window owns this host and pushes its phones itself. */
  hasWindow: () => boolean
  readNotificationSettings: () => NotificationSettings | undefined
  /** In-memory only, as the window's: the alert must not wait on a lookup. */
  readWorkspaceLabels: (worktreeId: string, paneKey: string) => TerminalAgentWorkspaceLabels
  isWorkspaceMuted: (worktreeId: string) => boolean
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  translate?: (key: string, fallback: string) => string
  dispatch: (event: MobileNotificationDispatchEvent) => void
  retire: (alerts: LiveNotificationRetirement[]) => void
  recordAnnounced: (paneKey: string, notificationId: string) => void
  now: () => number
}

export class TerminalAgentPhonePush {
  private readonly newsByPane = new Map<string, PaneNews>()
  private readonly recentDispatches = new Map<string, number>()
  private readonly titleWorking = new Set<string>()

  constructor(private readonly deps: TerminalAgentPhonePushDeps) {}

  observe(change: AgentPaneChange): void {
    const { paneKey } = change
    const row = this.deps.readHookRow(paneKey)
    if (change.kind === 'moved' || !row) {
      if (
        !row &&
        ((change.kind === 'moved' && change.to === 'working') ||
          (change.kind === 'seeded' && change.phase === 'working'))
      ) {
        this.titleWorking.add(paneKey)
      }
      if (change.kind === 'moved' && change.to === 'rest') {
        this.titleWorking.delete(paneKey)
        if (this.newsByPane.get(paneKey)?.worktreeId === change.workspace.worktreeId) {
          this.forget(paneKey)
        }
      }
      if (!row && change.kind === 'observed') {
        this.forget(paneKey)
      }
      return
    }
    if (!change.workspace || row.structuredHost) {
      this.forget(paneKey)
      return
    }
    if (row.providerSessionOnly || row.programStatusOnly) {
      return
    }
    const worktreeId = change.workspace.worktreeId
    const source = JSON.stringify([
      worktreeId,
      row.connectionId,
      row.terminalHandle,
      row.runId,
      row.executionId,
      row.authorityRestartId,
      row.agentType
    ])
    let news = this.newsByPane.get(paneKey)
    if (news?.source !== source) {
      this.forget(paneKey)
      const workingObserved = this.titleWorking.delete(paneKey)
      const retirement = createAgentHookNotificationRetirement(
        () => row.terminalHandle ?? null,
        this.deps.retire
      )
      const entry: PaneNews = {
        source,
        worktreeId,
        retirement,
        observer: createHookOnlyCompletionObserver({
          paneKey,
          workingObserved,
          isLive: () =>
            this.newsByPane.get(paneKey) === entry && this.deps.readHookRow(paneKey) !== null,
          dispatch: (snapshot) => this.send(paneKey, entry, snapshot)
        })
      }
      this.newsByPane.set(paneKey, entry)
      news = entry
      if (
        change.kind === 'observed' &&
        row.state === 'done' &&
        row.turnEndDisposition === undefined &&
        !workingObserved
      ) {
        news.observer.seedHookStatus(row)
        return
      }
    }
    if (change.kind === 'seeded' || row.isReplay || row.restoredUnconfirmed) {
      news.retirement.clear()
      news.observer.seedHookStatus(row)
    } else {
      news.retirement.observe(row)
      news.observer.observeHookStatus(row)
    }
  }

  private forget(paneKey: string): void {
    const news = this.newsByPane.get(paneKey)
    news?.observer.dispose()
    news?.retirement.clear()
    this.newsByPane.delete(paneKey)
  }

  dispose(): void {
    for (const paneKey of this.newsByPane.keys()) {
      this.forget(paneKey)
    }
    this.titleWorking.clear()
  }

  private buildEvent(
    worktreeId: string,
    paneKey: string,
    row: AgentCompletionStatusSnapshot
  ): MobileNotificationDispatchEvent {
    const outcome = agentMainAgentVerdict(row)
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      paneKey,
      ...this.readLabels(worktreeId, paneKey),
      agentState: row.state,
      ...(row.agentType ? { agentType: row.agentType } : {}),
      ...(row.prompt ? { agentPrompt: row.prompt } : {}),
      ...(row.toolName ? { agentToolName: row.toolName } : {}),
      ...(row.toolInput ? { agentToolInput: row.toolInput } : {}),
      ...(row.lastAssistantMessage ? { agentLastAssistantMessage: row.lastAssistantMessage } : {}),
      ...(outcome ? { agentTurnOutcome: outcome } : {})
    }
    const { title, body } = buildNotificationOptions(request, this.deps.translate)
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey,
      stateStartedAt: selectHookNotificationTimestamp(row)
    })
    return {
      type: 'notification',
      source: 'agent-task-complete',
      title,
      body,
      worktreeId,
      ...(notificationId ? { notificationId } : {}),
      agentState: row.state
    }
  }

  private send(paneKey: string, news: PaneNews, snapshot: AgentCompletionStatusSnapshot): void {
    if (
      this.deps.hasWindow() ||
      this.deps.isWorkspaceMuted(news.worktreeId) ||
      agentTurnEndedOnPurpose(snapshot)
    ) {
      return
    }
    const event = this.buildEvent(news.worktreeId, paneKey, snapshot)
    const settings = this.deps.readNotificationSettings()
    // The window's own fan-out gates the phone on these same preferences.
    const desktopAllowed = settings?.enabled !== false && settings?.agentTaskComplete !== false
    const now = this.deps.now()
    const burstKey = JSON.stringify([desktopAllowed, event.agentState, news.worktreeId])
    if (!reserveNotificationCooldown(this.recentDispatches, burstKey, now)) {
      return
    }
    this.deps.dispatch({
      ...event,
      emittedAt: now,
      ...(!desktopAllowed ? { desktopAllowed: false } : {})
    })
    if (event.notificationId) {
      this.deps.recordAnnounced(paneKey, event.notificationId)
      news.retirement.record({ notificationId: event.notificationId }, snapshot)
    }
  }

  private readLabels(worktreeId: string, paneKey: string): TerminalAgentWorkspaceLabels {
    try {
      return this.deps.readWorkspaceLabels(worktreeId, paneKey)
    } catch {
      // A label is presentation: without one the alert still goes out, worded generically.
      return {}
    }
  }
}
