import { parsePaneKey } from '../../shared/stable-pane-id'
import { isAgentLaunchRunningIn } from '../agent-launch/agent-launch-pane-attachment'
import type { TerminalInterfaceTarget } from '../agent-hooks/server/terminal-interface-authority'
import { OrcaRuntimeWithAgentTransitions } from './orca-runtime-agent-transitions'
import { OrcaRuntimeWithSidebarTemporal } from './sidebar-inputs/orca-runtime-sidebar-temporal'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'

// Switch point: a window-fed build keeps no sidebar facts layer.
const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

export class OrcaRuntimeWithTerminalInterfaces extends OrcaRuntimeSidebarBase {
  protected installTerminalInterfaceHost(): void {
    if (this.terminalInterfaces) {
      const authority = this.terminalInterfaces
      const offInput = this.terminalRunFacts.onObservationInput((ptyId, kind) =>
        authority.input(ptyId, kind)
      )
      const stop = authority.install({
        dispose: offInput,
        inventory: () => this.terminalInterfaceInventory(),
        inspect: (binding) =>
          this.ptyController?.inspectProcess?.(binding.ptyId, {
            expectedIncarnationId: binding.incarnationId,
            scanChildProcesses: true,
            terminalInterface: true
          }) ?? Promise.resolve(null),
        changed: () => {
          this.emitClientEvent(authority.snapshotEvent())
          for (const worktreeId of this.mobileSessionTabsByWorktree.keys()) {
            this.touchMobileSessionTabsForWorktree(worktreeId, { immediate: true })
          }
        }
      })
      this.registerSubscriptionCleanup('terminal-interface-host', () => {
        offInput()
        stop()
      })
    }
  }
  private terminalInterfaceInventory(): TerminalInterfaceTarget[] {
    return [...this.ptysById.values()].flatMap((pty) => {
      if (!pty.connected || !pty.incarnationId || !pty.paneKey) {
        return []
      }
      const terminalHandle = this.handleByPtyId.get(pty.ptyId)
      if (!terminalHandle) {
        return []
      }
      const pane = parsePaneKey(pty.paneKey)
      return [
        {
          binding: {
            ptyId: pty.ptyId,
            incarnationId: pty.incarnationId,
            paneKey: pty.paneKey,
            worktreeId: pty.worktreeId,
            terminalHandle
          },
          generation: this.getPtyLifecycleGeneration(pty.ptyId),
          launchToken: pty.launchToken ?? null,
          local: pty.connectionId === null && pty.isWsl !== true,
          blocked:
            this.intentionalPtyStops.hasStop(pty.ptyId, pty.incarnationId) ||
            (pane !== null && isAgentLaunchRunningIn(pty.worktreeId, { kind: 'pane', ...pane })) ||
            this.isWorktreeTerminalSleepHeld(pty.worktreeId) ||
            this.terminalPaneRecoveryByIdentity.has(`${pty.worktreeId}\0${pty.paneKey}`)
        }
      ]
    })
  }
}
