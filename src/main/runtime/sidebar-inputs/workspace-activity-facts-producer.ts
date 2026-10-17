import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import { agentStatusEvidenceObservedAt } from '../../../shared/agent-status-freshness'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  isIdleWorkspaceActivity,
  liveAgentStatusOf,
  strongerLiveAgentStatus,
  workspaceActivityFactsEqual,
  type LiveAgentWorktreeStatus,
  type WorkspaceActivityFacts,
  type WorkspaceActivityFactsSnapshot
} from '../../../shared/sidebar-list/workspace-activity-facts'
import type { AgentHookServer } from '../../agent-hooks/server'

export type WorkspaceSurfaceActivity = Omit<WorkspaceActivityFacts, 'agent'>

/** The hook server's store, read one pane at a time. */
export type AgentStatusStoreView = Pick<
  AgentHookServer,
  | 'getStatusSnapshot'
  | 'getStatusSnapshotForPane'
  | 'subscribeStatusRowMutations'
  | 'subscribeStatusFreshness'
>

type AgentPane = { worktreeId: string; status: LiveAgentWorktreeStatus; staleAt: number }

/**
 * Per-workspace activity facts the sidebar builder reads, kept current one workspace at a time.
 * Surfaces are re-read when the runtime publishes a workspace's tabs; agent rows follow the hook
 * server's per-row mutations, so a status ping costs one pane, never a scan.
 */
export class WorkspaceActivityFactsProducer {
  private readonly facts = new Map<string, WorkspaceActivityFacts>()
  private readonly agentPanes = new Map<string, AgentPane>()
  private readonly agentPanesByWorktree = new Map<string, Map<string, AgentPane>>()
  private revision = 0
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private expiryAt = Infinity

  constructor(
    private readonly deps: {
      readSurfaces: (worktreeId: string) => WorkspaceSurfaceActivity
      resolveTabWorktreeId: (tabId: string) => string | undefined
    }
  ) {}

  snapshot(): WorkspaceActivityFactsSnapshot {
    return { revision: this.revision, facts: Object.fromEntries(this.facts) }
  }

  refreshWorkspace(worktreeId: string): void {
    const next: WorkspaceActivityFacts = {
      ...this.deps.readSurfaces(worktreeId),
      agent: this.agentStatusFor(worktreeId)
    }
    const previous = this.facts.get(worktreeId)
    if (isIdleWorkspaceActivity(next)) {
      if (!previous) {
        return
      }
      this.facts.delete(worktreeId)
    } else {
      if (previous && workspaceActivityFactsEqual(previous, next)) {
        return
      }
      this.facts.set(worktreeId, next)
    }
    this.revision += 1
  }

  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    const refreshPane = (paneKey: string): void =>
      this.setAgentPane(paneKey, store.getStatusSnapshotForPane(paneKey))
    for (const paneKey of new Set(store.getStatusSnapshot().map((row) => row.paneKey))) {
      refreshPane(paneKey)
    }
    const unsubscribeMutations = store.subscribeStatusRowMutations(({ before, after }) => {
      if (before) {
        refreshPane(before.paneKey)
      }
      if (after && after.paneKey !== before?.paneKey) {
        refreshPane(after.paneKey)
      }
    })
    // Duplicate evidence renews a row's lease without a semantic mutation.
    const unsubscribeFreshness = store.subscribeStatusFreshness(({ paneKey }) =>
      refreshPane(paneKey)
    )
    return () => {
      unsubscribeMutations()
      unsubscribeFreshness()
      this.clearExpiryTimer()
    }
  }

  private setAgentPane(paneKey: string, rows: readonly AgentStatusIpcPayload[]): void {
    const previous = this.agentPanes.get(paneKey)
    const next = this.toAgentPane(rows, Date.now())
    if (previous) {
      this.unindexAgentPane(paneKey, previous.worktreeId)
    }
    if (next) {
      this.agentPanes.set(paneKey, next)
      const panes = this.agentPanesByWorktree.get(next.worktreeId) ?? new Map<string, AgentPane>()
      this.agentPanesByWorktree.set(next.worktreeId, panes.set(paneKey, next))
      this.armExpiry(next.staleAt)
    } else {
      this.agentPanes.delete(paneKey)
    }
    if (previous) {
      this.refreshWorkspace(previous.worktreeId)
    }
    if (next && next.worktreeId !== previous?.worktreeId) {
      this.refreshWorkspace(next.worktreeId)
    }
  }

  private toAgentPane(rows: readonly AgentStatusIpcPayload[], now: number): AgentPane | null {
    const live: AgentPane[] = []
    for (const row of rows) {
      const entry = {
        state: row.state,
        workingMode: row.workingMode,
        updatedAt: row.receivedAt,
        evidenceObservedAt: row.evidenceObservedAt,
        restoredUnconfirmed: row.restoredUnconfirmed,
        ...(row.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
      }
      const worktreeId = this.agentRowWorktreeId(row)
      if (row.providerSessionOnly || !worktreeId || !isFreshNonDoneAgentStatus(entry, now)) {
        continue
      }
      live.push({
        worktreeId,
        status: liveAgentStatusOf(entry),
        staleAt: entry.structuredHostOwned
          ? Infinity
          : agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS + 1
      })
    }
    if (live.length === 0) {
      return null
    }
    return {
      worktreeId: live[0].worktreeId,
      status: live.reduce<LiveAgentWorktreeStatus>(
        (status, pane) => strongerLiveAgentStatus(status, pane.status),
        live[0].status
      ),
      staleAt: Math.min(...live.map((pane) => pane.staleAt))
    }
  }

  // The window's attribution rule: host-reported ownership for remote panes, else the pane's tab.
  private agentRowWorktreeId(row: AgentStatusIpcPayload): string | undefined {
    const tabId =
      row.tabId ?? parsePaneKey(row.paneKey)?.tabId ?? parseLegacyNumericPaneKey(row.paneKey)?.tabId
    if (row.worktreeId && (row.connectionId || isWebTerminalSurfaceTabId(tabId ?? ''))) {
      return row.worktreeId
    }
    return (tabId ? this.deps.resolveTabWorktreeId(tabId) : undefined) ?? row.worktreeId
  }

  private unindexAgentPane(paneKey: string, worktreeId: string): void {
    const panes = this.agentPanesByWorktree.get(worktreeId)
    if (panes?.delete(paneKey) && panes.size === 0) {
      this.agentPanesByWorktree.delete(worktreeId)
    }
  }

  private agentStatusFor(worktreeId: string): LiveAgentWorktreeStatus | null {
    let status: LiveAgentWorktreeStatus | null = null
    for (const pane of this.agentPanesByWorktree.get(worktreeId)?.values() ?? []) {
      status = strongerLiveAgentStatus(status, pane.status)
    }
    return status
  }

  // One timer for the earliest lease; a renewed lease only moves later, so an early fire re-arms.
  private armExpiry(staleAt: number): void {
    if (staleAt >= this.expiryAt) {
      return
    }
    this.clearExpiryTimer()
    this.expiryAt = staleAt
    this.expiryTimer = setTimeout(() => this.expireAgentPanes(), staleAt - Date.now())
    // A lease must never keep a headless host from its idle exit.
    this.expiryTimer.unref?.()
  }

  private expireAgentPanes(): void {
    this.expiryTimer = null
    this.expiryAt = Infinity
    const now = Date.now()
    let nextStaleAt = Infinity
    for (const [paneKey, pane] of this.agentPanes) {
      if (pane.staleAt > now) {
        nextStaleAt = Math.min(nextStaleAt, pane.staleAt)
        continue
      }
      this.agentPanes.delete(paneKey)
      this.unindexAgentPane(paneKey, pane.worktreeId)
      this.refreshWorkspace(pane.worktreeId)
    }
    if (nextStaleAt !== Infinity) {
      this.armExpiry(nextStaleAt)
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
    }
    this.expiryTimer = null
    this.expiryAt = Infinity
  }
}
