import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../shared/constants'
import type { SmartSortSources } from '../../../shared/sidebar-list/smart-sort'
import type { SidebarTemporalSnapshot } from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { getMigrationUnsupportedPtySnapshot } from '../../agent-hooks/migration-unsupported-pty-state'
import {
  SidebarTemporalOwner,
  type SidebarRetentionCandidates,
  type SidebarSortSample
} from './sidebar-temporal-owner'
import { SmartSortAgentEntries } from './smart-sort-agent-entries'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

type Runtime = OrcaRuntimeWithWorkspaceReviewFacts

/**
 * Feeds main's temporal owner. Its sort inputs bump the settle window the way the window's
 * sortEpoch does: row and catalog changes, agent rows, activity, and terminal titles or bindings.
 */
export abstract class OrcaRuntimeWithSidebarTemporal extends OrcaRuntimeWithWorkspaceReviewFacts {
  private readonly smartSortAgentEntries = new SmartSortAgentEntries()
  readonly sidebarTemporal = new SidebarTemporalOwner(this.sidebarClock, {
    sortBy: () => this.store?.getUI?.().sortBy ?? 'smart',
    showSleepingWorkspaces: () =>
      this.store?.getUI?.().showSleepingWorkspaces ?? DEFAULT_SHOW_SLEEPING_WORKSPACES,
    readSortSample: () => this.readSidebarSortSample(),
    retentionCandidates: () => this.readSidebarRetentionCandidates()
  })

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceReviewFacts>) {
    super(...args)
    this.workspaceActivityFacts.onChange(() => this.sidebarTemporal.noteActivityChange())
    this.store?.onUIChanged?.(() => this.sidebarTemporal.noteViewChange())
    this.noteSidebarRowsChange()
  }

  getSidebarTemporalSnapshot(): SidebarTemporalSnapshot {
    return this.sidebarTemporal.snapshot()
  }

  /** Attaches every sidebar producer that reads the hook server's store. */
  attachSidebarAgentStatusStore(store: AgentStatusStoreView): () => void {
    const detachActivity = this.workspaceActivityFacts.attachAgentStatusStore(store)
    const detachEntries = this.smartSortAgentEntries.attach(store, () =>
      this.sidebarTemporal.noteSortInputChange()
    )
    return () => {
      detachActivity()
      detachEntries()
      this.sidebarTemporal.dispose()
    }
  }

  override notifyWorktreesChanged(...args: Parameters<Runtime['notifyWorktreesChanged']>): void {
    super.notifyWorktreesChanged(...args)
    this.noteSidebarRowsChange()
  }

  override syncWindowGraph(...args: Parameters<Runtime['syncWindowGraph']>) {
    const before = this.sidebarTerminalSortSignature()
    const result = super.syncWindowGraph(...args)
    if (this.sidebarTerminalSortSignature() !== before) {
      this.sidebarTemporal.noteSortInputChange()
    }
    return result
  }

  // The row count decides whether a change settles at once, so read it after the change lands.
  private noteSidebarRowsChange(): void {
    void this.listResolvedWorktreeSnapshot().then(
      ({ worktrees }) =>
        this.sidebarTemporal.noteRowsChange(
          worktrees.filter((worktree) => !worktree.isArchived).length
        ),
      (error: unknown) => console.warn('[sidebar-temporal] could not count rows', error)
    )
  }

  // Titles and bindings Smart scores; a graph sync that leaves them alone re-sorts nothing.
  private sidebarTerminalSortSignature(): string {
    const parts: string[] = []
    for (const tab of this.tabs.values()) {
      parts.push(`${tab.tabId}\u0000${tab.title ?? ''}`)
    }
    for (const leaf of this.leaves.values()) {
      parts.push(
        `${leaf.tabId}\u0000${leaf.paneRuntimeId}\u0000${leaf.paneTitle ?? ''}\u0000${leaf.ptyId ?? ''}`
      )
    }
    return parts.join('\u0001')
  }

  private async readSidebarSortSample(): Promise<SidebarSortSample> {
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    return {
      worktrees,
      repoMap: new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo])),
      sources: this.readSmartSortSources()
    }
  }

  /** The window's Smart inputs, from this runtime's tabs, leaves and hook rows. */
  private readSmartSortSources(): SmartSortSources {
    const tabsByWorktree: SmartSortSources['tabsByWorktree'] = {}
    const tabIds = new Set<string>()
    const addTab = (worktreeId: string, id: string, title: string): void => {
      if (!tabIds.has(id)) {
        tabIds.add(id)
        tabsByWorktree[worktreeId] = [...(tabsByWorktree[worktreeId] ?? []), { id, title }]
      }
    }
    const terminalLayoutsByTabId: SmartSortSources['terminalLayoutsByTabId'] = {}
    for (const tab of this.tabs.values()) {
      addTab(tab.worktreeId, tab.tabId, tab.title ?? '')
      terminalLayoutsByTabId[tab.tabId] = {
        root: tab.layout,
        activeLeafId: tab.activeLeafId,
        expandedLeafId: null
      }
    }
    // A tab with no mounted or parked terminal reaches main only through its session snapshot.
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      for (const tab of snapshot.tabs) {
        if (tab.type === 'terminal') {
          addTab(worktreeId, tab.parentTabId, tab.title)
        }
      }
    }
    const ptyIdsByTabId: Record<string, string[]> = {}
    const runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {}
    for (const leaf of this.leaves.values()) {
      // The window holds no unverifiable state: a binding whose host lost contact is still live there.
      if (
        leaf.ptyId &&
        (leaf.connected || this.getPtyLivenessVerdict(leaf.ptyId)?.status === 'unverifiable')
      ) {
        ptyIdsByTabId[leaf.tabId] = [...(ptyIdsByTabId[leaf.tabId] ?? []), leaf.ptyId]
      }
      if (leaf.paneTitle) {
        runtimePaneTitlesByTabId[leaf.tabId] = {
          ...runtimePaneTitlesByTabId[leaf.tabId],
          [leaf.paneRuntimeId]: leaf.paneTitle
        }
      }
    }
    const migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry> = {}
    for (const entry of getMigrationUnsupportedPtySnapshot()) {
      migrationUnsupportedByPtyId[entry.ptyId] = entry
    }
    return {
      tabsByWorktree,
      agentStatusByPaneKey: this.smartSortAgentEntries.byPaneKey(),
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      migrationUnsupportedByPtyId,
      terminalLayoutsByTabId
    }
  }

  private readSidebarRetentionCandidates(): SidebarRetentionCandidates {
    const { facts } = this.workspaceActivityFacts.snapshot()
    return {
      ids: Object.keys(facts),
      isActive: (worktreeId) => worktreeId in facts,
      isUnverifiableGap: (worktreeId) =>
        !this.terminalSleepByWorktreeId.has(worktreeId) &&
        (this.mobileSessionTabsByWorktree
          .get(worktreeId)
          ?.tabs.some((tab) => tab.type === 'terminal') ??
          [...this.tabs.values()].some((tab) => tab.worktreeId === worktreeId))
    }
  }
}
