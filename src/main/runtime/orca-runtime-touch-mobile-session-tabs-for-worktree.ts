// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './orca-runtime-publish-pty-backed-mobile-session-terminal'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { hasHostAuthoritativeTerminalMembership } from '../persistence/terminal-topology/terminal-topology-membership'
import type { RuntimeSyncedLeaf } from '../../shared/runtime-types'

export class OrcaRuntimeWithTouchMobileSessionTabsForWorktree extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  /** Emit at a new snapshot version, coalesced unless `immediate`. */
  touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options: { immediate?: boolean } = {}
  ): void {
    if (!this.sessionTabsWorktreeIds().includes(worktreeId)) {
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.observeWorktreeRefresh(worktreeId)
    if (options.immediate) {
      // Why: an exit is structural and must not wait behind the title/status window. A
      // registration's ready flip coalesces so it merges with the spawn's graph update.
      this.notifyMobileSessionTabsChanged(worktreeId)
      return
    }
    // Why: title/status flips several times a second under spinner-in-title
    // agents. Coalesce the emit instead of fanning out every version.
    this.scheduleMobileSessionTabsChanged(worktreeId)
  }

  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    this.mobileSessionTabsAgentStatusHeartbeat.scheduleWorktreeHeartbeat(worktreeId)
  }

  /** Republish the workspace snapshot after a pane's hook status changed.
   *  Hook rows feed the headless `agentStatus` projection, which nothing else touches. */
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void {
    const resolved = worktreeId ?? this.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!resolved) {
      return
    }
    this.touchMobileSessionTabsForWorktree(resolved)
  }

  protected mobileSessionSnapshotHasSurface(
    worktreeId: string,
    parentTabId: string,
    leafId: string
  ): boolean {
    return Boolean(
      this.readSessionTabsSnapshot(worktreeId)?.tabs.some(
        (tab) => tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
      )
    )
  }

  protected isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    // Why `?? undefined`: the absence of a session is what licenses membership,
    // so a partition miss must read as absent and not as a distinct null value.
    const session = this.getWorkspaceSessionForWorktree(worktreeId) ?? undefined
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (
      !hasHostAuthoritativeTerminalMembership(session, worktreeId) &&
      (session !== undefined || !this.terminalTopologyRevisionByRepoId.has(repoId))
    ) {
      return true
    }
    if (this.mobileSessionSnapshotHasSurface(worktreeId, parentTabId, leafId)) {
      return true
    }
    if (!candidatePtyId) {
      return false
    }
    const pty = this.ptysById.get(candidatePtyId)
    const pane = parsePaneKey(pty?.paneKey ?? '')
    return Boolean(
      pty?.connected &&
      pty.worktreeId === worktreeId &&
      pty.tabId === parentTabId &&
      pane?.leafId === leafId
    )
  }

  protected reconcileMobileSessionRetirementFences(
    leaves: readonly RuntimeSyncedLeaf[]
  ): RuntimeSyncedLeaf[] {
    return leaves.filter((leaf) =>
      this.isMobileSessionSurfaceMembershipAllowed(
        leaf.worktreeId,
        leaf.tabId,
        leaf.leafId,
        leaf.ptyId
      )
    )
  }
}
