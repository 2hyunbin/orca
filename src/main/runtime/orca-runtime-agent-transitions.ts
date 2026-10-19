import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { WorkspaceViewers } from './sidebar-inputs/workspace-viewers'
import type { AgentStatusStoreView } from './sidebar-inputs/workspace-activity-facts-producer'
import { readWorkspaceNotificationLabels } from './structured-agent-session-mobile-attention'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'

/**
 * Owns the runtime's agent transition detector and the phone push it drives, which run on every
 * host and in every build.
 */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    now: Date.now
  })
  readonly workspaceViewers = new WorkspaceViewers(Date.now)
  private readonly terminalAgentPhonePush = new TerminalAgentPhonePush({
    readNotificationSettings: () => this.store?.getSettings().notifications,
    readWorkspaceLabels: (worktreeId) => this.readTerminalAgentWorkspaceLabels(worktreeId),
    isWorkspaceMuted: (worktreeId) => this.isWorkspaceNotificationMuted(worktreeId),
    isPhoneLooking: (worktreeId) => this.workspaceViewers.isPhoneViewing(worktreeId),
    readHookRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
    translate: (key, fallback) =>
      getRuntimeDesktopSurface().translateNotification?.(key, fallback) ?? fallback,
    dispatch: (event) => this.mobileNotifications.dispatch(event),
    setTimer: (run, delayMs) => {
      // A pending finish must never hold the process open at quit.
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return { cancel: () => clearTimeout(timer) }
    },
    now: Date.now
  })

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithMigrationCatalog>) {
    super(...args)
    this.agentTransitions.subscribe((change) => this.terminalAgentPhonePush.observe(change))
  }

  /** Attaches the detector; layers above subscribe their readers first. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    return this.agentTransitions.attach(store)
  }

  /** A phone holding the workspace's session open is looking at it, until the returned release. */
  openPhoneWorkspaceSession(worktreeId: string): () => void {
    const release = this.workspaceViewers.openPhoneSession(worktreeId)
    return () => {
      release()
      this.terminalAgentPhonePush.notePhoneSessionClosed(worktreeId)
    }
  }

  /** This host's own handling of the terminal-agent news a window's request carries, if any. */
  terminalAgentNewsDeliveredByHost(
    request: NotificationDispatchRequest
  ): { notificationId: string } | null {
    return this.terminalAgentPhonePush.coveringNews(request)
  }

  private readTerminalAgentWorkspaceLabels(worktreeId: string) {
    const store = this.store
    if (!store) {
      return {}
    }
    const labels = readWorkspaceNotificationLabels(store, worktreeId)
    if (labels.worktreeLabel) {
      return labels
    }
    // As the window: an unnamed worktree reads as its branch.
    const listed = this.resolvedWorktrees.peek()?.worktrees.find((item) => item.id === worktreeId)
    const worktreeLabel = listed?.displayName || listed?.branch
    return worktreeLabel ? { ...labels, worktreeLabel } : labels
  }
}
