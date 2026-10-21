import { createTerminalAgentMobileAttention } from './terminal-agent-mobile-attention'
import { readStructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'
import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { AgentStatusStoreView } from './sidebar-inputs/workspace-activity-facts-producer'

/** Owns the runtime's agent transition detector, which runs on every host and in every build. */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    now: Date.now
  })

  /** Attaches the detector; layers above subscribe their readers first. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    const alerts = createTerminalAgentMobileAttention({
      readRow: (key) => this.agentTransitions.latestRow(key),
      readNotificationSettings: () => this.store?.getSettings().notifications,
      readWorkspaceLabels: (workspaceId) =>
        this.store ? readStructuredAttentionWorkspaceLabels(this.store, { workspaceId }) : {},
      isWorkspaceMuted: (id) => this.isWorkspaceNotificationMuted(id),
      dispatch: (event) => this.mobileNotifications.dispatch(event),
      retire: (ids) => this.mobileNotifications.retireLiveNotifications(ids),
      now: Date.now
    })
    const stopAlerts = this.agentTransitions.subscribe(alerts.observe)
    const stop = this.agentTransitions.attach(store)
    return () => {
      stop()
      stopAlerts()
      alerts.dispose()
    }
  }
}
