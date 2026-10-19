// The execution host's own phone push for hook-reported terminal agents: a turn that finished (or
// failed) and an agent that needs input, the news the transition detector names.
//
// WHY THE HOST: the hooks land in this host's status store, so a phone paired to a server with no
// window (`orca serve`, `orcad`) must not depend on a desktop window to make the call. On a desktop,
// main marks its own window's request for the same news `mobileDeliveredByHost`, so the phone is
// not pushed twice.
//
// TIMING: a finish waits out the same quiet window the desktop's does, so a goal agent's milestone
// is not announced. A phone holding the workspace's session open is looking at it; a locked phone
// keeps that session for up to a minute, so news landing while a phone holds it waits: pushed if
// every phone session on the workspace ends within the minute, dropped otherwise.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { worktreeIdentityKey } from '../../shared/worktree/id'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import type { StructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'

/** How long a locked phone can keep its session open; news held for it waits this long. */
export const PHONE_LOOKING_LINGER_MS = 60_000

type PaneNews = {
  worktreeId: string
  paneKey: string
  stateStartedAt: number
  event: MobileNotificationDispatchEvent
  /** Waiting out a finish's quiet window. */
  quiet: { cancel: () => void } | null
  /** Set while the news waits on a phone that holds the workspace open. */
  heldUntil: number | null
}

export type TerminalAgentPhonePushDeps = {
  readNotificationSettings: () => NotificationSettings | undefined
  /** In-memory only, as the structured lane's: the alert must not wait on a lookup. */
  readWorkspaceLabels: (worktreeId: string) => StructuredAttentionWorkspaceLabels
  isWorkspaceMuted: (worktreeId: string) => boolean
  isPhoneLooking: (worktreeId: string) => boolean
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  translate?: (key: string, fallback: string) => string
  dispatch: (event: MobileNotificationDispatchEvent) => void
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

export class TerminalAgentPhonePush {
  // A pane's current news, until the pane moves on; at most one per pane.
  private readonly newsByPane = new Map<string, PaneNews>()
  // The window's own fan-out keeps this same burst gate.
  private readonly recentDispatches = new Map<string, number>()

  constructor(private readonly deps: TerminalAgentPhonePushDeps) {}

  observe(change: AgentPaneChange): void {
    if (change.kind !== 'moved') {
      return
    }
    this.newsByPane.get(change.paneKey)?.quiet?.cancel()
    this.newsByPane.delete(change.paneKey)
    const { transition } = change
    if (
      transition !== 'turn-finished' &&
      transition !== 'errored' &&
      transition !== 'needs-input'
    ) {
      return
    }
    const row = this.deps.readHookRow(change.paneKey)
    // A structured chat's projected row is pushed by the structured lane.
    if (!row || row.structuredHost) {
      return
    }
    const { worktreeId } = change.workspace
    const muted = this.deps.isWorkspaceMuted(worktreeId)
    // Muted news is still recorded: it is this host's call, so the window's copy stays silent too.
    const news = this.buildNews(worktreeId, change.paneKey, row)
    this.newsByPane.set(change.paneKey, news)
    if (muted) {
      return
    }
    if (transition === 'needs-input') {
      this.deliverUnlessLooking(news)
      return
    }
    news.quiet = this.deps.setTimer(() => {
      news.quiet = null
      if (this.newsByPane.get(news.paneKey) === news && !this.deps.isWorkspaceMuted(worktreeId)) {
        this.deliverUnlessLooking(news)
      }
    }, AGENT_DONE_QUIET_MS)
  }

  /** A phone let go of the workspace; news held for it goes out once no phone holds it. */
  notePhoneSessionClosed(worktreeId: string): void {
    if (this.deps.isPhoneLooking(worktreeId)) {
      return
    }
    const key = worktreeIdentityKey(worktreeId)
    const now = this.deps.now()
    for (const news of this.newsByPane.values()) {
      if (news.heldUntil === null || worktreeIdentityKey(news.worktreeId) !== key) {
        continue
      }
      // Held past the linger, the phone was really showing it.
      const due = now <= news.heldUntil
      news.heldUntil = null
      if (due && !this.deps.isWorkspaceMuted(news.worktreeId)) {
        this.send(news)
      }
    }
  }

  /**
   * Whether this host has the very news a window's request announces, and the id it pushed it
   * under. Matched by the id both mint from the hook row, in the request's own workspace spelling;
   * a request without one (a title or exit completion) is the window's alone.
   */
  coveringNews(request: NotificationDispatchRequest): { notificationId: string } | null {
    if (
      request.source !== 'agent-task-complete' ||
      request.executionHost ||
      !request.paneKey ||
      !request.notificationId
    ) {
      return null
    }
    const news = this.newsByPane.get(request.paneKey)
    const sameNews =
      news &&
      buildAgentNotificationId({
        worktreeId: request.worktreeId,
        paneKey: request.paneKey,
        stateStartedAt: news.stateStartedAt
      }) === request.notificationId
    return sameNews && news.event.notificationId
      ? { notificationId: news.event.notificationId }
      : null
  }

  private deliverUnlessLooking(news: PaneNews): void {
    if (this.deps.isPhoneLooking(news.worktreeId)) {
      news.heldUntil = this.deps.now() + PHONE_LOOKING_LINGER_MS
    } else {
      this.send(news)
    }
  }

  private buildNews(worktreeId: string, paneKey: string, row: AgentStatusIpcPayload): PaneNews {
    const outcome = agentMainAgentVerdict(row)
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      paneKey,
      ...this.readLabels(worktreeId),
      agentState: row.state,
      ...(row.agentType ? { agentType: row.agentType } : {}),
      ...(row.prompt ? { agentPrompt: row.prompt } : {}),
      ...(row.toolName ? { agentToolName: row.toolName } : {}),
      ...(row.toolInput ? { agentToolInput: row.toolInput } : {}),
      ...(row.lastAssistantMessage ? { agentLastAssistantMessage: row.lastAssistantMessage } : {}),
      ...(outcome ? { agentTurnOutcome: outcome } : {})
    }
    const { title, body } = buildNotificationOptions(request, this.deps.translate)
    // The window mints the same id from the same row, so its read retires this push too.
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey,
      stateStartedAt: row.stateStartedAt
    })
    return {
      worktreeId,
      paneKey,
      stateStartedAt: row.stateStartedAt,
      quiet: null,
      heldUntil: null,
      event: {
        type: 'notification',
        source: 'agent-task-complete',
        title,
        body,
        worktreeId,
        ...(notificationId ? { notificationId } : {}),
        agentState: row.state
      }
    }
  }

  private send(news: PaneNews): void {
    const settings = this.deps.readNotificationSettings()
    // The window's own fan-out gates the phone on these same preferences.
    const desktopAllowed = settings?.enabled !== false && settings?.agentTaskComplete !== false
    const now = this.deps.now()
    const burstKey = JSON.stringify([desktopAllowed, news.event.agentState, news.worktreeId])
    if (!reserveNotificationCooldown(this.recentDispatches, burstKey, now)) {
      return
    }
    // No attention key: later cooldowns then key on the workspace, as the window's request does.
    this.deps.dispatch({
      ...news.event,
      emittedAt: now,
      ...(!desktopAllowed ? { desktopAllowed: false } : {})
    })
  }

  private readLabels(worktreeId: string): StructuredAttentionWorkspaceLabels {
    try {
      return this.deps.readWorkspaceLabels(worktreeId)
    } catch {
      // A label is presentation: without one the alert still goes out, worded generically.
      return {}
    }
  }
}
