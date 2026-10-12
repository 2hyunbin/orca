/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal } from './orca-runtime-create-runtime-owned-mobile-session-terminal'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { worktreeIdsEqual } from '../../shared/worktree/id'
import type {
  RuntimePtyTabCloseAuthority,
  RuntimePtyWorktreeRecord
} from './runtime-terminal-state-records'

export class OrcaRuntimeWithWaitForMobileTerminalSurface extends OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal {
  protected findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    return {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  protected findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tabs = result.tabs.filter(
      (candidate): candidate is RuntimeMobileSessionTerminalClientTab =>
        candidate.type === 'terminal' &&
        (candidate.ptyId === ptyId ||
          candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
    )
    if (tabs.length === 0 || new Set(tabs.map((tab) => tab.parentTabId)).size !== 1) {
      return null
    }
    return {
      tab: tabs[0]!,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }

  protected resolvePtyTabCloseSurfaceAuthority(
    authority: RuntimePtyTabCloseAuthority
  ): { pty: RuntimePtyWorktreeRecord; surface: RuntimeMobileSessionCreateTerminalResult } | null {
    const live = this.getLivePtyForHandle(authority.handle)
    if (
      !live ||
      live.pty.ptyId !== authority.ptyId ||
      live.pty.worktreeId !== authority.worktreeId ||
      live.record.worktreeId !== authority.worktreeId ||
      live.pty.incarnationId !== authority.incarnationId
    ) {
      return null
    }
    const surface = this.findMobileTerminalSurfaceForPty(authority.worktreeId, authority.ptyId)
    if (!surface) {
      return null
    }
    const [hostId] = this.getWorkspaceSessionHostIdsForTab(
      authority.worktreeId,
      surface.tab.parentTabId
    )
    const session = hostId ? (this.store?.getWorkspaceSession?.(hostId) ?? null) : null
    const sessionWorktreeId = session
      ? resolveTerminalSessionWorktreeId(session, authority.worktreeId)
      : null
    const persistedTab = sessionWorktreeId
      ? session?.tabsByWorktree[sessionWorktreeId]?.find(
          (tab) => tab.id === surface.tab.parentTabId
        )
      : undefined
    if (persistedTab && !worktreeIdsEqual(persistedTab.worktreeId, authority.worktreeId)) {
      return null
    }
    const paneKey = makePaneKey(surface.tab.parentTabId, surface.tab.leafId)
    const persistedPtyId =
      session?.terminalLayoutsByTabId?.[surface.tab.parentTabId]?.ptyIdsByLeafId?.[
        surface.tab.leafId
      ] ?? null
    const persistedIncarnationId = session?.terminalPtyIncarnationsByPaneKey?.[paneKey] ?? null
    if (
      (persistedPtyId && persistedPtyId !== authority.ptyId) ||
      (persistedIncarnationId && persistedIncarnationId !== authority.incarnationId)
    ) {
      return null
    }
    if (
      !this.resolveTerminalSplitSourceAuthority(
        authority.worktreeId,
        surface.tab.parentTabId,
        surface.tab.leafId,
        authority.ptyId
      )
    ) {
      return null
    }
    return { pty: live.pty, surface }
  }
}
