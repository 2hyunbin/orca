import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalWaiter
} from '../../runtime-terminal-contracts'
import {
  TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from '../../orca-runtime-postlude'
import { withTimeout } from '../../runtime-async-boundaries'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptSettled
} from '../../terminal-wait-detection'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { restoreProjectedComposerDraft } from '../../orca-runtime-terminal-projection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason,
  RuntimeTerminalRead
} from '../../../../shared/runtime-types'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from '../../terminal-wait-results'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'

type TerminalWaitVisibleProbeHost = {
  readTerminal(
    handle: string,
    opts: { screen?: boolean },
    providerSnapshot: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalRead>
  getLivePtyForHandle(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeafForHandle(handle: string): { leaf: RuntimeLeafRecord }
}

export class TerminalWaitVisibleProbe {
  constructor(
    private readonly host: TerminalWaitVisibleProbeHost,
    private readonly terminalWaiters: RuntimeTerminalWaiterRegistry
  ) {}

  // This provider read is single-shot; the shared idle sweep owns later transitions.
  startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void {
    const settleMarginMs = Math.min(
      TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
      Math.max(1, Math.floor(waiterTimeoutMs / 3))
    )
    const probeTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS + settleMarginMs,
      Math.max(0, waiterTimeoutMs - settleMarginMs)
    )
    const providerTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      Math.max(0, probeTimeoutMs - settleMarginMs)
    )
    if (providerTimeoutMs < 1) {
      return
    }
    const screenRule = readsTrustedScreen(agent)
    void withTimeout(
      this.host.readTerminal(waiter.handle, screenRule ? { screen: true } : {}, {
        timeoutMs: providerTimeoutMs,
        retireOnTimeout: true,
        // Why: the ready banner stays in scrollback for the whole session, so
        // classifying history would call a working agent idle (#15569 review).
        visibleScreenOnly: true
      } satisfies RuntimeProviderSnapshotReadOptions),
      probeTimeoutMs,
      null
    )
      .then((projection) => {
        if (
          !projection ||
          projection.source !== 'screen' ||
          !this.terminalWaiters.get(waiter.handle)?.has(waiter)
        ) {
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        // Why the shared tier-1 rule: a probe must not settle what the live screen would refuse.
        const ready = screenRule
          ? isKnownReadyPromptBody(
              snapshotText,
              agent,
              () => restoreProjectedComposerDraft(projection.tail, projection.draft),
              // Why read now: output since the probe started makes the pane clocked.
              (
                this.host.getLivePtyForHandle(waiter.handle)?.pty ??
                this.host.getLiveLeafForHandle(waiter.handle).leaf
              ).lastOutputAt !== null
            )
          : isKnownReadyPromptSettled(snapshotText)
        if (!blockedReason && !ready) {
          return
        }
        const result = this.buildTuiIdleProbeResult(waiter.handle, blockedReason)
        if (waiter.cancelIdlePoll) {
          waiter.cancelIdlePoll()
        }
        this.terminalWaiters.resolve(waiter, result)
      })
      .catch(() => {})
  }

  buildTuiIdleProbeResult(
    handle: string,
    blockedReason: RuntimeTerminalWaitBlockedReason | null
  ): RuntimeTerminalWait {
    const pty = this.host.getLivePtyForHandle(handle)
    if (pty) {
      return blockedReason
        ? buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty.pty, blockedReason)
        : buildPtyTerminalWaitResult(handle, 'tui-idle', pty.pty)
    }
    const { leaf } = this.host.getLiveLeafForHandle(handle)
    return blockedReason
      ? buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, blockedReason)
      : buildTerminalWaitResult(handle, 'tui-idle', leaf)
  }
}
