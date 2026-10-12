// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWaitForLeafPtyId } from './orca-runtime-wait-for-leaf-pty-id'
import type { RuntimeTerminalFocus } from '../../shared/runtime-types'
import { parsePaneKey } from '../../shared/stable-pane-id'

export class OrcaRuntimeWithFocusTerminal extends OrcaRuntimeWithWaitForLeafPtyId {
  async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean } = {}
  ): Promise<RuntimeTerminalFocus> {
    const navigateHost = options.navigateHost !== false
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_exited')
      }
      const tabId = pty.pty.tabId ?? pty.record.tabId
      const navigated = navigateHost && this.layoutHolder.findTerminalTab(tabId) !== null
      if (navigated) {
        this.focusHeldTerminalInDesktopView(pty.pty, { navigate: true })
      }
      return { handle, tabId, worktreeId: pty.pty.worktreeId, navigated }
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const location = navigateHost ? this.layoutHolder.findTerminalTab(leaf.tabId) : null
    if (location) {
      this.navigateDesktopView(location.workspace, { tabId: location.tabId, leafId: leaf.leafId })
    }
    return { handle, tabId: leaf.tabId, worktreeId: leaf.worktreeId, navigated: location !== null }
  }

  protected getPtyIdsForExplicitTabClose(worktreeId: string, tabId: string): string[] {
    const ptyIds = new Set<string>()
    for (const pty of this.ptysById.values()) {
      if (pty.connected && pty.worktreeId === worktreeId && pty.tabId === tabId) {
        ptyIds.add(pty.ptyId)
      }
    }
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktreeId && leaf.tabId === tabId && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }
    return [...ptyIds]
  }

  /** The desktop view shows a terminal's pane; `navigate` also tells its window to go there. */
  protected focusHeldTerminalInDesktopView(
    pty: { worktreeId: string; tabId: string | null; paneKey: string | null },
    options: { navigate?: boolean } = {}
  ): void {
    const leafId = parsePaneKey(pty.paneKey ?? '')?.leafId
    const tab = this.heldWorkspaceLayout(pty.worktreeId)?.tabs.find(
      (candidate) => candidate.kind === 'terminal' && candidate.entityId === pty.tabId
    )
    if (!tab) {
      return
    }
    const target = { tabId: tab.id, ...(leafId ? { leafId } : {}) }
    if (options.navigate) {
      this.navigateDesktopView(pty.worktreeId, target)
    } else {
      this.focusInDesktopView(pty.worktreeId, target)
    }
  }
}
