import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { resolveAgentStatusLiveEntryStateHistory } from '../../../shared/agent-status-live-entry-state-history'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

/**
 * The hook store's rows as the entries Smart scores, one per pane. The store keeps no history,
 * so state switches are recorded here, as the window records them from the same rows.
 */
export class SmartSortAgentEntries {
  private readonly entries = new Map<string, AgentStatusEntry>()
  private store: AgentStatusStoreView | null = null

  attach(store: AgentStatusStoreView, onChange: () => void): () => void {
    this.store = store
    for (const row of store.getStatusSnapshot()) {
      this.refreshPane(row.paneKey)
    }
    const unsubscribe = store.subscribeStatusRowMutations(({ before, after }) => {
      for (const paneKey of new Set([before?.paneKey, after?.paneKey])) {
        if (paneKey) {
          this.refreshPane(paneKey)
        }
      }
      onChange()
    })
    return () => {
      unsubscribe()
      this.store = null
      this.entries.clear()
    }
  }

  byPaneKey(): Record<string, AgentStatusEntry> {
    return Object.fromEntries(this.entries)
  }

  private refreshPane(paneKey: string): void {
    // The window applies a pane's rows in arrival order, so the newest is the one it holds.
    const rows = (this.store?.getStatusSnapshotForPane(paneKey) ?? []).filter(
      (row) => !row.providerSessionOnly
    )
    const latest = rows.reduce<AgentStatusIpcPayload | null>(
      (newest, row) => (newest && newest.receivedAt >= row.receivedAt ? newest : row),
      null
    )
    if (!latest) {
      this.entries.delete(paneKey)
      return
    }
    const existing = this.entries.get(paneKey)
    const { history, stateObservedAt } = resolveAgentStatusLiveEntryStateHistory(
      existing,
      latest,
      latest.receivedAt
    )
    this.entries.set(paneKey, {
      state: latest.state,
      ...(latest.workingMode !== undefined ? { workingMode: latest.workingMode } : {}),
      prompt: latest.prompt,
      updatedAt: latest.receivedAt,
      ...(latest.evidenceObservedAt !== undefined
        ? { evidenceObservedAt: latest.evidenceObservedAt }
        : {}),
      ...(latest.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {}),
      stateStartedAt: latest.stateStartedAt,
      stateObservedAt,
      ...(latest.turnStartedAt !== undefined ? { turnStartedAt: latest.turnStartedAt } : {}),
      agentType: latest.agentType,
      paneKey,
      ...(latest.worktreeId ? { worktreeId: latest.worktreeId } : {}),
      ...(latest.tabId ? { tabId: latest.tabId } : {}),
      stateHistory: history,
      ...(latest.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
      interrupted: latest.interrupted,
      sessionBoundary: latest.sessionBoundary,
      ...(latest.mainAgent ? { mainAgent: latest.mainAgent } : {})
    })
  }
}
