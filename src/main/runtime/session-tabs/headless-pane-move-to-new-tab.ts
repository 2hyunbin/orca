import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './headless-terminal-tab-close'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../pty-recorded-surface-topology'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import {
  isTerminalLeafMoveRequest,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'

export abstract class OrcaRuntimeWithHeadlessPaneMoveToNewTab extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  // Why: a client's pane-to-new-tab move must reach the host session or the next snapshot rebuilds
  // the old tab. A window-owned host keeps its layout in the renderer, so only headless hosts commit.
  async moveMobileSessionLeafToNewTab(
    worktreeSelector: string,
    args: { sourceTabId: string; targetTabId: string; leafId: string },
    commit: (move: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>
  ): Promise<TerminalLeafMoveResult> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    if (this.getAvailableAuthoritativeWindow()) {
      return { status: 'not_held' }
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Why: the client's pty id mirrors a host handle; the host names its own bound pty.
    const move = { ...args, worktreeId, ptyId: null }
    if (!isValidHostTerminalTabId(move.targetTabId) || !isTerminalLeafMoveRequest(move)) {
      return { status: 'refused', reason: 'invalid_request' }
    }
    const result = await commit(move)
    if (result.status === 'moved') {
      // The live PTY follows its pane, or tab-scoped reads and actions still find it in the source.
      const pty = result.ptyId ? this.ptysById.get(result.ptyId) : undefined
      if (pty) {
        recordPtySurface(
          pty,
          move.targetTabId,
          makePaneKey(move.targetTabId, move.leafId),
          spawnSurfaceClaimSequence(this.graphSequence)
        )
      }
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
    return result
  }
}
