import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { AgentStatusStoreView } from './sidebar-inputs/workspace-activity-facts-producer'
import { readStructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'
import { createTerminalAgentMobileAttention } from './terminal-agent-mobile-attention'

/** Owns the runtime's agent transition detector, which runs on every host and in every build. */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    now: Date.now
  })

  /** Attaches the detector; layers above subscribe their readers first. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    const phoneAlerts = createTerminalAgentMobileAttention({
      readRow: (paneKey) => this.agentTransitions.latestRow(paneKey),
      readNotificationSettings: () => this.store?.getSettings().notifications,
      readWorkspaceLabels: (workspaceId) =>
        this.store ? readStructuredAttentionWorkspaceLabels(this.store, { workspaceId }) : {},
      isWorkspaceMuted: (workspaceId) => this.isWorkspaceNotificationMuted(workspaceId),
      dispatch: (event) => this.mobileNotifications.dispatch(event),
      retire: (worktreeId, paneKey, before) =>
        this.mobileNotifications.retireTerminalAttention(worktreeId, paneKey, before),
      now: Date.now
    })
    const detachPhoneAlerts = this.agentTransitions.subscribe(phoneAlerts.observe)
    const detachDetector = this.agentTransitions.attach(store)
    return () => {
      detachDetector()
      detachPhoneAlerts()
      phoneAlerts.dispose()
    }
  }
}
