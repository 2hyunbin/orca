import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../shared/constants'
import type { SidebarTemporalSnapshot } from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import { getMigrationUnsupportedPtySnapshot } from '../../agent-hooks/migration-unsupported-pty-state'
import {
  SidebarTemporalOwner,
  type SidebarRetentionCandidates,
  type SidebarSortSample
} from './sidebar-temporal-owner'
import { SmartSortAgentEntries } from './smart-sort-agent-entries'
import { buildRuntimeSmartSortSources } from './runtime-smart-sort-sources'
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
    // A scan here would race the change's own listing; the last listing's count is enough.
    const worktrees = this.resolvedWorktrees.peek()?.worktrees
    this.sidebarTemporal.noteRowsChange(
      worktrees?.filter((worktree) => !worktree.isArchived).length
    )
  }

  override syncWindowGraph(...args: Parameters<Runtime['syncWindowGraph']>) {
    const before = this.sidebarTerminalSortSignature()
    const result = super.syncWindowGraph(...args)
    if (this.sidebarTerminalSortSignature() !== before) {
      this.sidebarTemporal.noteSortInputChange()
    }
    return result
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
      sources: buildRuntimeSmartSortSources({
        tabs: this.tabs.values(),
        leaves: this.leaves.values(),
        sessionTabs: this.mobileSessionTabsByWorktree,
        isUnverifiablePty: (ptyId) => this.getPtyLivenessVerdict(ptyId)?.status === 'unverifiable',
        agentStatusByPaneKey: this.smartSortAgentEntries.byPaneKey(),
        migrationUnsupported: getMigrationUnsupportedPtySnapshot()
      })
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
