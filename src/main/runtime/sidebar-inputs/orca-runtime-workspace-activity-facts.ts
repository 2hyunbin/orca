import { OrcaRuntimeWithMigrationCatalog } from '../orca-runtime-migration-catalog'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import type {
  WorkspaceActivityFactsSnapshot,
  WorkspaceTerminalLiveness
} from '../../../shared/sidebar-list/workspace-activity-facts'
import { worktreeIdComparisonKey } from '../../../shared/worktree/id'
import {
  WorkspaceActivityFactsProducer,
  type WorkspaceSurfaceActivity
} from './workspace-activity-facts-producer'

/**
 * Feeds the activity producer from the runtime's own funnels: every per-workspace session.tabs
 * publication (already coalesced, and fired for status-only changes too), plus PTY liveness
 * changes that reach no publication.
 */
export abstract class OrcaRuntimeWithWorkspaceActivityFacts extends OrcaRuntimeWithMigrationCatalog {
  readonly workspaceActivityFacts = new WorkspaceActivityFactsProducer({
    readSurfaces: (worktreeId) => this.readWorkspaceSurfaceActivity(worktreeId),
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId
  })

  getWorkspaceActivityFacts(): WorkspaceActivityFactsSnapshot {
    return this.workspaceActivityFacts.snapshot()
  }

  protected override notifyMobileSessionTabsChangedNow(
    worktreeId: string,
    changeSequence: number
  ): void {
    super.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
    this.workspaceActivityFacts.refreshWorkspace(worktreeId)
  }

  protected override notifyMobileSessionTabSnapshots(): void {
    super.notifyMobileSessionTabSnapshots()
    for (const worktreeId of this.mobileSessionTabsByWorktree.keys()) {
      this.workspaceActivityFacts.refreshWorkspace(worktreeId)
    }
  }

  protected override notifyMobileSessionTabsRemoved(worktreeId: string): void {
    super.notifyMobileSessionTabsRemoved(worktreeId)
    this.workspaceActivityFacts.refreshWorkspace(worktreeId)
  }

  override onPtyExit(
    ...args: Parameters<OrcaRuntimeWithMigrationCatalog['onPtyExit']>
  ): ReturnType<OrcaRuntimeWithMigrationCatalog['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    if (worktreeId) {
      this.workspaceActivityFacts.refreshWorkspace(worktreeId)
    }
    return result
  }

  protected override rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    super.rememberPtyLivenessVerdict(ptyId, verdict)
    this.refreshPtyWorkspace(ptyId)
  }

  protected override forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void {
    super.forgetPtyLivenessVerdict(ptyId, observedNoLaterThan)
    this.refreshPtyWorkspace(ptyId)
  }

  private refreshPtyWorkspace(ptyId: string): void {
    const worktreeId = this.ptysById.get(ptyId)?.worktreeId
    if (worktreeId) {
      this.workspaceActivityFacts.refreshWorkspace(worktreeId)
    }
  }

  private readWorkspaceSurfaceActivity(worktreeId: string): WorkspaceSurfaceActivity {
    const tabs = this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []
    return {
      terminal: this.readWorkspaceTerminalLiveness(worktreeId),
      browser: tabs.some((tab) => tab.type === 'browser'),
      structuredChat: tabs.some((tab) => tab.type === 'agent-session')
    }
  }

  // getLivePtyIdsForWorktree's identity rule in one pass that stops at the first live PTY; a host
  // that only lost contact keeps its terminals unverifiable, never gone.
  private readWorkspaceTerminalLiveness(worktreeId: string): WorkspaceTerminalLiveness | null {
    const key = worktreeIdComparisonKey(worktreeId)
    const owns = (id: string): boolean =>
      id === worktreeId || (key !== null && worktreeIdComparisonKey(id) === key)
    let unverifiable = false
    for (const surfaces of [this.leaves.values(), this.ptysById.values()]) {
      for (const surface of surfaces) {
        if (surface.ptyId === null || !owns(surface.worktreeId)) {
          continue
        }
        if (surface.connected) {
          return 'live'
        }
        unverifiable ||= this.getPtyLivenessVerdict(surface.ptyId)?.status === 'unverifiable'
      }
    }
    return unverifiable ? 'unverifiable' : null
  }
}
