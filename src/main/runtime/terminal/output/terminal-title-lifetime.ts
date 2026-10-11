import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function disposePtyTitleTracker(output: RuntimeTerminalOutputOwner, ptyId: string): void {
  output.host.observeClaudeTerminalEvidence(ptyId, { kind: 'reset' })
  output.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.dispose()
  output.ptyTitleTrackersByPtyId.delete(ptyId)
  output.host.ptyForegroundAgent.clearDelayedSnapshot(ptyId)
  output.host.openCodeRunLifetime.forgetPty(ptyId)
  output.host.mobileSessionTabsAgentStatusHeartbeat.removePty(ptyId)
  output.host.clientEvents.clearPtyTitleGate(ptyId)
}

export function resetTrackedTerminalStateForProviderGeneration(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): void {
  // Why: a replacement daemon session can reuse the PTY id, but title/parser
  // state from the prior process must not bleed into its snapshots or chunks.
  output.host.disposePtyTitleTracker(ptyId)
  output.oscTitleScanTailByPtyId.delete(ptyId)
  output.osc7ScanTailByPtyId.delete(ptyId)
  output.agentStatusOscProcessorsByPtyId.delete(ptyId)
  output.host.agentPromptLifecycleByPtyId.delete(ptyId)
  output.host.agentPromptPermissionSequenceByPtyId.delete(ptyId)
  output.host.clearAgentPromptCorrelationForPty(ptyId)
  output.host.clearWaitBlockedCheckState(ptyId)
  const pty = output.host.ptysById.get(ptyId)
  if (pty) {
    pty.lastOscTitle = null
    pty.lastOscTitleAt = null
    pty.lastOscTitleEpochMs = null
    pty.titleDisplayClear = null
    pty.lastAgentStatus = null
    // Why: the prior process's first-party status would otherwise veto idle for its
    // replacement — a stale `working` keeps tui-idle unresolved on the new generation.
    pty.lastExplicitAgentStatus = null
    // Why: the prior process's live frames say nothing about the replacement,
    // so the seed a same-id restore applies must not inherit its authority.
    pty.lastAgentStatusObservedLive = false
    pty.lastAgentStatusStartedAtEpochMs = null
    pty.lastAgentStatusRichInvalidatedAtEpochMs = Date.now()
    pty.managementTitle = null
    pty.managementTitleAt = null
    pty.waitBlockedAt = null
    pty.tailWaitState = undefined
    pty.commandPaint = undefined
  }
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    leaf.lastOscTitle = null
    leaf.lastOscTitleAt = null
    leaf.lastAgentStatus = null
    leaf.lastAgentStatusObservedLive = false
    leaf.waitBlockedAt = null
    leaf.tailWaitState = undefined
  }
  output.host.reconcileEndedProcess(() => output.host.collectAgentStatusPaneKeysForPty(ptyId))
  output.host.primeWaitBlockedBaselineFromSeededTail(ptyId)
}

export function setTerminalSideEffectConsumerAvailable(
  output: RuntimeTerminalOutputOwner,
  available: boolean
): void {
  output.terminalSideEffectLocalConsumerAvailable =
    available && output.host.onTerminalSideEffects !== null
  output.host.refreshTerminalSideEffectConsumerAvailability()
}

export function refreshTerminalSideEffectConsumerAvailability(
  output: RuntimeTerminalOutputOwner
): void {
  const nextAvailable =
    output.terminalSideEffectLocalConsumerAvailable ||
    output.host.countTerminalSideEffectConsumingClientEventListeners() > 0
  if (nextAvailable === output.terminalSideEffectConsumerAvailable) {
    return
  }
  output.terminalSideEffectConsumerAvailable = nextAvailable
  for (const [ptyId, entry] of output.ptyTitleTrackersByPtyId) {
    entry.tracker.setTransientSideEffectScanningEnabled(nextAvailable)
    entry.commandCodeDetector = nextAvailable
      ? output.host.createTerminalSideEffectCommandCodeDetector(ptyId)
      : null
  }
}
