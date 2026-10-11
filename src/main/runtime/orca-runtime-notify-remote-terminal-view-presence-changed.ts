// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { TerminalLayoutCommands } from './terminal/layout/terminal-layout-commands'
import { OrcaRuntimeWithRecordAgentPromptLifecycleState } from './orca-runtime-record-agent-prompt-lifecycle-state'

import type { RuntimeTerminalBufferSnapshot } from './runtime-terminal-state-records'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'
import { assertTerminalInputWithinLimitWithYield } from './terminal-send-payload'

export class OrcaRuntimeWithNotifyRemoteTerminalViewPresenceChanged extends OrcaRuntimeWithRecordAgentPromptLifecycleState {
  protected notifyRemoteTerminalViewPresenceChanged(ptyId: string): void {
    try {
      this.onRemoteTerminalViewPresenceChanged?.(ptyId)
    } catch (err) {
      console.error('[runtime] remote view presence listener threw', { ptyId, err })
    }
  }

  /** Registered by terminal-RPC subscribe/multiplex streams: while a remote
   *  view subscriber is attached its xterm answers queries with view
   *  authority and the model responder must stay silent. Returns an
   *  idempotent release. */
  registerRemoteTerminalViewSubscriber(
    ...args: Parameters<TerminalLayoutCommands['registerRemoteTerminalViewSubscriber']>
  ): ReturnType<TerminalLayoutCommands['registerRemoteTerminalViewSubscriber']> {
    return this.terminalLayout.commands.registerRemoteTerminalViewSubscriber(...args)
  }

  /** A local daemon session main knows is live but has never ingested a byte
   *  from — i.e. no pane ever attached it, so the daemon is not emitting.
   *  Headless state exists only after the first ingested byte; a snapshot
   *  reconcile in flight implies a spawn-path attach already happened. */
  protected isKnownUnattachedLocalDaemonPty(
    ...args: Parameters<TerminalLayoutCommands['isKnownUnattachedLocalDaemonPty']>
  ): ReturnType<TerminalLayoutCommands['isKnownUnattachedLocalDaemonPty']> {
    return this.terminalLayout.commands.isKnownUnattachedLocalDaemonPty(...args)
  }

  protected reconcileSubscriberDrivenProviderAttach(
    ...args: Parameters<TerminalLayoutCommands['reconcileSubscriberDrivenProviderAttach']>
  ): ReturnType<TerminalLayoutCommands['reconcileSubscriberDrivenProviderAttach']> {
    return this.terminalLayout.commands.reconcileSubscriberDrivenProviderAttach(...args)
  }

  /** Mark a raw-output viewer without transferring terminal query authority. */
  registerRawTerminalViewSubscriber(
    ...args: Parameters<TerminalLayoutCommands['registerRawTerminalViewSubscriber']>
  ): ReturnType<TerminalLayoutCommands['registerRawTerminalViewSubscriber']> {
    return this.terminalLayout.commands.registerRawTerminalViewSubscriber(...args)
  }

  /** Raw stream presence prevents provider thinning without changing reply ownership. */
  hasRawTerminalViewSubscriber(
    ...args: Parameters<TerminalLayoutCommands['hasRawTerminalViewSubscriber']>
  ): ReturnType<TerminalLayoutCommands['hasRawTerminalViewSubscriber']> {
    return this.terminalLayout.commands.hasRawTerminalViewSubscriber(...args)
  }

  hasRemoteTerminalViewSubscriber(
    ...args: Parameters<TerminalLayoutCommands['hasRemoteTerminalViewSubscriber']>
  ): ReturnType<TerminalLayoutCommands['hasRemoteTerminalViewSubscriber']> {
    return this.terminalLayout.commands.hasRemoteTerminalViewSubscriber(...args)
  }

  isMobileTerminalQueryReplyAuthority(
    ...args: Parameters<TerminalLayoutCommands['isMobileTerminalQueryReplyAuthority']>
  ): ReturnType<TerminalLayoutCommands['isMobileTerminalQueryReplyAuthority']> {
    return this.terminalLayout.commands.isMobileTerminalQueryReplyAuthority(...args)
  }

  subscribeToFitOverrideChanges(
    ...args: Parameters<TerminalLayoutCommands['subscribeToFitOverrideChanges']>
  ): ReturnType<TerminalLayoutCommands['subscribeToFitOverrideChanges']> {
    return this.terminalLayout.commands.subscribeToFitOverrideChanges(...args)
  }

  subscribeToDriverChanges(
    ...args: Parameters<TerminalLayoutCommands['subscribeToDriverChanges']>
  ): ReturnType<TerminalLayoutCommands['subscribeToDriverChanges']> {
    return this.terminalLayout.commands.subscribeToDriverChanges(...args)
  }

  protected notifyFitOverrideListeners(
    ...args: Parameters<TerminalLayoutCommands['notifyFitOverrideListeners']>
  ): ReturnType<TerminalLayoutCommands['notifyFitOverrideListeners']> {
    return this.terminalLayout.commands.notifyFitOverrideListeners(...args)
  }

  serializeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  async serializeAuthoritativeTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<RuntimeTerminalBufferSnapshot | null> {
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts, {
      timeoutMs: AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      retireOnTimeout: true
    })
    if (providerSnapshot) {
      return providerSnapshot
    }
    return this.serializeTerminalBufferFromAvailableState(ptyId, opts)
  }

  /** Raw keystroke pass-through for the pop-out dashboard's terminal preview.
   *  Honors the mobile-presence lock like the main window's pty:write path. */
  async writeTerminalPreviewInput(ptyId: string, data: string): Promise<boolean> {
    if (data.length === 0 || this.getDriver(ptyId).kind === 'mobile') {
      return false
    }
    try {
      await assertTerminalInputWithinLimitWithYield(data)
      await this.writeTerminalInputChunks(ptyId, data, {
        inputKind: 'driving',
        // Why: a phone can claim the floor while a paste yields between chunks.
        beforeWrite: () => {
          if (this.getDriver(ptyId).kind === 'mobile') {
            throw new Error('terminal_mobile_driver_active')
          }
        }
      })
      return true
    } catch {
      return false
    }
  }

  hasHeadlessTerminalState(ptyId: string): boolean {
    return this.headlessTerminals.has(ptyId)
  }
}
