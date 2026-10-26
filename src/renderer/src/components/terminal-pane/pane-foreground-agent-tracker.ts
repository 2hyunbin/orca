import { createPaneForegroundObservationTransitions } from './pane-foreground-observation-transitions'
import { notifyPaneStartupStateChanged } from '@/lib/pane-spawn-deferral-registry'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { createPaneForegroundProcessReader } from './pane-foreground-process-reader'
import { FOREGROUND_COMMAND_READS } from '../../../../shared/foreground-command-settle'
import {
  isObservationOwnerSuperseded,
  type ForegroundReadReason,
  type PaneForegroundAgentTracker,
  type PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

const VISIBLE_PTY_SETTLE_MS = 350

/** Read foreground identity at command boundaries; confirm 133;D before clearing known agents because nested shells can leak that marker. */
export function createPaneForegroundAgentTracker(
  deps: PaneForegroundAgentTrackerDeps
): PaneForegroundAgentTracker {
  let disposed = false
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledReadReason: ForegroundReadReason | null = null
  let activeReadReason: ForegroundReadReason | null = null
  let readGeneration = 0
  // Nested agent shells leak 133;D onto the main PTY; confirm foreground before treating it as prompt return.
  let hasForegroundAgentEvidence = false
  // D ends presentation history; the process monitor owns lifetime independently.
  let hasKnownAgentEvidence = false
  let hasAgentExpectation = false
  let startupSampled = false
  const readProcess = createPaneForegroundProcessReader(deps)
  const markForegroundAgentEvidence = (): void => {
    hasForegroundAgentEvidence = true
    hasAgentExpectation = false
  }
  const clearAgentEvidence = (): void => {
    hasForegroundAgentEvidence = false
    hasKnownAgentEvidence = false
    hasAgentExpectation = false
  }

  const trackablePtyId = (): string | null => {
    const ptyId = deps.getPtyId()
    return ptyId && deps.isTrackablePtyId(ptyId) ? ptyId : null
  }

  const cancelPendingRead = (): void => {
    readGeneration += 1
    if (readTimer !== null) {
      clearTimeout(readTimer)
      readTimer = null
    }
    scheduledReadReason = null
    activeReadReason = null
    notifyPaneStartupStateChanged()
  }

  const scheduleRead = (
    delayMs: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): void => {
    const generation = readGeneration
    scheduledReadReason = reason
    notifyPaneStartupStateChanged()
    readTimer = setTimeout(() => {
      readTimer = null
      scheduledReadReason = null
      activeReadReason = reason
      void readForeground(generation, retryIndex, reason).finally(() => {
        if (generation === readGeneration && activeReadReason === reason) {
          activeReadReason = null
          notifyPaneStartupStateChanged()
        }
      })
    }, delayMs)
  }

  const hasPendingRead = (): boolean => scheduledReadReason !== null || activeReadReason !== null
  const hasCommandReadInFlight = (): boolean =>
    scheduledReadReason === 'command' ||
    activeReadReason === 'command' ||
    scheduledReadReason === 'command-finished' ||
    activeReadReason === 'command-finished'

  // Release retained capabilities when a read ends; superseded reads delegate settlement to their successor.
  const releaseRetainedCapability = (hadReadInFlight: boolean): void => {
    if (hadReadInFlight) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  const settleAbortedRead = (generation: number): void => {
    if (!disposed && generation === readGeneration) {
      deps.onVisibleForegroundSettled?.('inconclusive')
    }
  }

  async function readForeground(
    generation: number,
    retryIndex: number,
    reason: ForegroundReadReason
  ): Promise<void> {
    const ptyId = trackablePtyId()
    if (disposed || generation !== readGeneration || !ptyId) {
      settleAbortedRead(generation)
      return
    }
    const requiresRoutingConfirmation =
      reason === 'command-finished' ||
      hasForegroundAgentEvidence ||
      hasKnownAgentEvidence ||
      hasAgentExpectation
    const ownerAtRequest = deps.getObservationOwner?.()
    const { processName, remoteEvidenceVerdict, expectedIncarnationId, remote } = await readProcess(
      ptyId,
      requiresRoutingConfirmation
    )
    // Fence pending inspection so an old PTY cannot publish identity into its replacement.
    if (
      disposed ||
      generation !== readGeneration ||
      trackablePtyId() !== ptyId ||
      isObservationOwnerSuperseded(ownerAtRequest, deps.getObservationOwner?.()) ||
      (remote && deps.getExpectedIncarnationId?.() !== expectedIncarnationId)
    ) {
      settleAbortedRead(generation)
      return
    }
    const recognized =
      remoteEvidenceVerdict === 'live'
        ? recognizeAgentProcess(processName)
        : remoteEvidenceVerdict !== null
          ? null
          : recognizeAgentProcess(processName)
    if (recognized) {
      markForegroundAgentEvidence()
      deps.publish({
        agent: recognized.agent,
        agentEvidence: 'process-read',
        shellForeground: false,
        ...(requiresRoutingConfirmation ? { routingTrusted: true } : {})
      })
      // Why: nothing else re-derives this read in a pane without command marks.
      if (!remote) {
        deps.onAgentProcessRead?.(recognized)
      }
      if (reason === 'visible-pty') {
        deps.onVisibleForegroundSettled?.('agent')
      }
      return
    }
    // 133;D cancels pending reads, so a surviving command read’s shell is nested and cannot prove prompt return.
    const retryDelay = FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
    const hasConfirmationExpectation =
      hasForegroundAgentEvidence || hasKnownAgentEvidence || hasAgentExpectation
    const shouldRetryExpectedIdentity =
      hasConfirmationExpectation && (reason !== 'command-finished' || processName === null)
    const shouldRetry =
      retryDelay !== undefined &&
      (shouldRetryExpectedIdentity ||
        (processName !== null &&
          (reason === 'command' || isAgentForegroundWrapperProcess(processName))))
    if (shouldRetry) {
      // Bound retries across PowerShell-to-WMIC enrichment, which may initially hide a live agent.
      scheduleRead(retryDelay, retryIndex + 1, reason)
      return
    }
    if (reason === 'command') {
      if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
        hasAgentExpectation = false
        return
      }
      hasAgentExpectation = false
      deps.publish({ agent: null, shellForeground: false })
      return
    }
    if (reason === 'visible-pty') {
      if (
        (hasForegroundAgentEvidence || hasKnownAgentEvidence) &&
        processName !== null &&
        isShellProcess(processName)
      ) {
        releaseForeground(reason)
        deps.onVisibleForegroundSettled?.('shell')
      } else {
        deps.onVisibleForegroundSettled?.('inconclusive')
      }
      return
    }
    if (reason === 'command-finished') {
      if (processName === null) {
        deps.onCommandFinishedUnavailable?.()
        return
      }
      if (!isShellProcess(processName)) {
        // Why: this read may have replaced a cancelled visible-pty confirmation.
        // It publishes nothing, so without settling here the capability it was
        // asked to revalidate would be retained with no read left to clear it.
        deps.onVisibleForegroundSettled?.('inconclusive')
        return
      }
      releaseForeground(reason)
    }
  }

  function releaseForeground(reason: 'visible-pty' | 'command-finished' | 'process-exit'): void {
    const accepted = deps.onConfirmedShellForeground?.(reason)
    if (accepted !== false && reason === 'command-finished') {
      if (accepted === true && (hasForegroundAgentEvidence || hasKnownAgentEvidence)) {
        deps.onConfirmedShellForeground?.('visible-pty')
      }
      clearAgentEvidence()
      startupSampled = false
      cancelPendingRead()
    }
    if (accepted !== undefined) {
      return
    }
    cancelPendingRead()
    // Foreground release preserves the monitor's lifetime identity through job control.
    deps.publish({ agent: null, shellForeground: true })
  }

  return {
    // A higher-authority command read still promises confirmation when visibility schedules nothing.
    hasReadInFlight(): boolean {
      return hasPendingRead()
    },
    onVisiblePtyBound(expectsAgent = false) {
      // Lower-authority visibility recovery must not cancel command-boundary reads that own the exit decision.
      if (hasCommandReadInFlight()) {
        return false
      }
      const hadReadBeforeVisibleBind = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeVisibleBind)
        return false
      }
      hasAgentExpectation ||= expectsAgent || deps.hasAgentExpectation?.() === true
      hasKnownAgentEvidence ||= deps.hasKnownAgentIdentity?.() === true
      // Why: restored/manual agent panes can become visible while Codex is
      // already foreground, so no OSC 133 command-start event will seed the tab icon.
      scheduleRead(VISIBLE_PTY_SETTLE_MS, 0, 'visible-pty')
      return true
    },
    onCommandStarted(expectedAgent = null) {
      startupSampled = false
      const hadReadBeforeCommandStart = hasPendingRead()
      cancelPendingRead()
      const ptyId = trackablePtyId()
      if (!ptyId) {
        releaseRetainedCapability(hadReadBeforeCommandStart)
        return
      }
      const alreadyHasKnownIdentity = deps.hasKnownAgentIdentity?.() === true
      hasAgentExpectation = expectedAgent !== null || deps.hasAgentExpectation?.() === true
      if (alreadyHasKnownIdentity) {
        hasKnownAgentEvidence = true
      }
      // New commands invalidate routing authority; launch/hook expectations and remote markers supply no identity before fresh host evidence.
      if (deps.isRemotePtyId?.(ptyId) !== true) {
        deps.publish({ agent: null, shellForeground: false })
      }
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onAgentStartupObserved() {
      if (
        disposed ||
        startupSampled ||
        hasForegroundAgentEvidence ||
        hasPendingRead() ||
        !trackablePtyId()
      ) {
        return
      }
      // A late startup title requests one bounded confirmation; it never supplies identity.
      startupSampled = true
      cancelPendingRead()
      hasAgentExpectation = true
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command')
    },
    onCommandFinished() {
      startupSampled = false
      hasAgentExpectation ||= deps.hasAgentExpectation?.() === true
      if (deps.hasKnownAgentIdentity?.() === true) {
        hasKnownAgentEvidence = true
      }
      // Any identity read cancelled by rapid 133;C→D needs reconfirmation; trusting D could latch shell state and permanently hide a reattached agent.
      const hadReadBeforeCommandFinish = hasPendingRead()
      cancelPendingRead()
      if (!trackablePtyId()) {
        releaseRetainedCapability(hadReadBeforeCommandFinish)
        return false
      }
      const ptyId = trackablePtyId()!
      // Trust D without an RPC only with no prior agent evidence, launch/hook identity or racing identity read.
      if (!hasForegroundAgentEvidence && !hasKnownAgentEvidence && !hasAgentExpectation) {
        if (deps.isRemotePtyId?.(ptyId) !== true) {
          deps.publish({ agent: null, shellForeground: true })
        }
        return false
      }
      // Confirm before clearing: a live agent republishes identity; a genuine shell result clears it.
      scheduleRead(FOREGROUND_COMMAND_READS.settleMs, 0, 'command-finished')
      return true
    },
    ...createPaneForegroundObservationTransitions({
      deps,
      disposed: () => disposed,
      hasCommandReadInFlight,
      cancelPendingRead,
      markForegroundAgentEvidence,
      clearAgentEvidence,
      resetStartup: () => {
        startupSampled = false
      }
    }),
    dispose() {
      const hadReadAtDispose = hasPendingRead()
      disposed = true
      cancelPendingRead()
      releaseRetainedCapability(hadReadAtDispose)
    }
  }
}
