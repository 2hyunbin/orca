// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeRendererSessionTerminalRescue } from './session-tabs/renderer-session-terminal-rescue'
import { OrcaRuntimeWithWaitForMobileTerminalSurface } from './orca-runtime-wait-for-mobile-terminal-surface'

export class OrcaRuntimeWithRestoreLivePairedRendererSessionOwnedMobileTerminals extends OrcaRuntimeWithWaitForMobileTerminalSurface {
  protected restoreLivePairedRendererSessionOwnedMobileTerminals(
    ...args: Parameters<
      RuntimeRendererSessionTerminalRescue['restoreLivePairedRendererSessionOwnedMobileTerminals']
    >
  ): ReturnType<
    RuntimeRendererSessionTerminalRescue['restoreLivePairedRendererSessionOwnedMobileTerminals']
  > {
    return this.runtimeRendererSessionTerminalRescue.restoreLivePairedRendererSessionOwnedMobileTerminals(
      ...args
    )
  }

  protected setPairedRendererSessionOwnership(
    ...args: Parameters<RuntimeRendererSessionTerminalRescue['setPairedRendererSessionOwnership']>
  ): ReturnType<RuntimeRendererSessionTerminalRescue['setPairedRendererSessionOwnership']> {
    return this.runtimeRendererSessionTerminalRescue.setPairedRendererSessionOwnership(...args)
  }

  protected findLiveRegisteredPtyForRendererTab(
    ...args: Parameters<RuntimeRendererSessionTerminalRescue['findLiveRegisteredPtyForRendererTab']>
  ): ReturnType<RuntimeRendererSessionTerminalRescue['findLiveRegisteredPtyForRendererTab']> {
    return this.runtimeRendererSessionTerminalRescue.findLiveRegisteredPtyForRendererTab(...args)
  }

  // Why: looser rollback guard than findLiveRegisteredPtyForRendererTab — a shell without a registered pane key is still a real terminal the timeout must not kill (#7718).
  protected hasLiveShellForRendererTab(
    ...args: Parameters<RuntimeRendererSessionTerminalRescue['hasLiveShellForRendererTab']>
  ): ReturnType<RuntimeRendererSessionTerminalRescue['hasLiveShellForRendererTab']> {
    return this.runtimeRendererSessionTerminalRescue.hasLiveShellForRendererTab(...args)
  }

  protected isReadyMobileTerminalSurface(
    ...args: Parameters<RuntimeRendererSessionTerminalRescue['isReadyMobileTerminalSurface']>
  ): ReturnType<RuntimeRendererSessionTerminalRescue['isReadyMobileTerminalSurface']> {
    return this.runtimeRendererSessionTerminalRescue.isReadyMobileTerminalSurface(...args)
  }

  // Why: a create can settle over a renderer PTY that spawned without its
  // startup command (the create's renderer stalled, #7587), silently binding
  // the client to a plain shell under an agent tab forever — once the surface
  // is ready, the activation-time materialize recovery (#7837) never runs
  // (STA-3214). Spawn commands are recorded per PTY at spawn time, so a
  // missing record on the locally registered live PTY proves the launch never
  // ran; type it into the shell like the create would have.
  protected deliverPendingStartupCommandToBareRendererPty(worktreeId: string, tabId: string): void {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    const command = pending?.startupCommand
    if (!command) {
      return
    }
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (!pty || this.terminalSpawnCommandsByPtyId.has(pty.ptyId)) {
      return
    }
    if (this.ptyController?.write(pty.ptyId, command, 'launch')) {
      // Why: Enter rides its own write so a long command cannot swallow it.
      this.ptyController.write(pty.ptyId, '\r', 'launch')
      this.noteTerminalSpawnCommand(pty.ptyId, command)
    }
  }

  protected waitForTerminalHandle(tabId: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.resolveHandleForTab(tabId)
    if (existing) {
      return Promise.resolve(existing)
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
        reject(new Error('Timed out waiting for terminal handle after creation'))
      }, timeoutMs)

      const check = (): void => {
        const handle = this.resolveHandleForTab(tabId)
        if (handle) {
          clearTimeout(timer)
          const idx = this.graphSyncCallbacks.indexOf(check)
          if (idx !== -1) {
            this.graphSyncCallbacks.splice(idx, 1)
          }
          resolve(handle)
        }
      }
      this.graphSyncCallbacks.push(check)
      // Why: graph sync may have fired between the initial check and registration; re-check to avoid a missed wake-up.
      check()
    })
  }
}
