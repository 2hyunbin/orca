// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { TerminalLayoutCommands } from './terminal/layout/terminal-layout-commands'
import { OrcaRuntimeWithOnPtyExit } from './orca-runtime-on-pty-exit'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'

import { getPtyTerminalState, getTerminalState } from './terminal-wait-results'

// Orphaned verdicts are bounded; active PTYs retain theirs until new evidence resolves them.
const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256

export class OrcaRuntimeWithMarkPtyLivenessUnverifiable extends OrcaRuntimeWithOnPtyExit {
  /**
   * Records that we lost contact with a PTY's owning host. Callers must never
   * read this as an exit: a detached relay PTY is designed to outlive the
   * provider that addressed it.
   */
  markPtyLivenessUnverifiable(ptyId: string, reason: string): void {
    this.rememberPtyLivenessVerdict(ptyId, { status: 'unverifiable', reason })
  }

  /**
   * A host positively observed this PTY. `observedNoLaterThan` fences the write against the
   * observation sequence the caller read at, so a slow in-flight listing cannot overwrite a
   * newer lost-contact verdict recorded while it was outstanding.
   */
  markPtyLivenessLive(ptyId: string, observedNoLaterThan?: number): void {
    const tracked = this.ptyLivenessVerdictByPtyId.get(ptyId)
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    if (tracked?.verdict.status === 'unverifiable') {
      void this.recheckHookAgentPresenceForPty(ptyId)
    }
    this.rememberPtyLivenessVerdict(ptyId, { status: 'live', ptyIds: [ptyId] })
  }

  /**
   * Records that Orca asked this PTY to stop — a close, a stop, a teardown.
   *
   * Why before the kill and not at the exit: a requested stop can still be
   * delivered by the provider's own exit event, which carries a process status
   * indistinguishable from a natural finish. The intent is the only thing that
   * separates "the operator closed it" from "the agent died", so it is recorded
   * where it is known rather than reconstructed afterwards (STA-4603).
   */
  markPtyStopRequested(ptyId: string): void {
    this.stopRequestedPtyIds.add(ptyId)
  }

  isPtyStopRequested(ptyId: string): boolean {
    return this.stopRequestedPtyIds.has(ptyId)
  }

  /**
   * Null when this register holds no defensible claim — a never-asked host, a fresh app start, or
   * an absence observation too weak to name (a relay that answered but does not know the id: see
   * the inventory sweep and handlePtyReattachFailure). It is NOT a death certificate, so a caller
   * authorizing a kill must fail closed on it; a caller that only has this evidence to work with,
   * like terminal.recoverPane, refuses on the positive verdicts instead.
   */
  getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null {
    return this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict ?? null
  }

  protected isPtyKnownExited(ptyId: string): boolean {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      // Why: `!connected` is an inference, not proof. The liveness sweep clears it with no
      // exit code for every PTY of a dropped relay, so reading that as an exit retires the
      // lease of a process still running on the host — 'unknown' must keep watching.
      return getPtyTerminalState(pty) === 'exited'
    }
    // Why: leavesByPtyId is rebuilt from the renderer graph independently of ptysById, so a
    // leaf can outlive (or precede) its pty record; without this an already-dead pty never
    // fires and the caller's release waits forever.
    return this.getLeavesForPty(ptyId).some((leaf) => getTerminalState(leaf) === 'exited')
  }

  subscribeToPtyExit(ptyId: string, listener: () => void): () => void {
    const lifecycleGeneration = this.getPtyLifecycleGeneration(ptyId)
    if (this.isPtyKnownExited(ptyId)) {
      listener()
      return () => {}
    }
    let listeners = this.ptyExitListenersByPtyId.get(ptyId)
    if (!listeners) {
      listeners = new Set()
      this.ptyExitListenersByPtyId.set(ptyId, listeners)
    }
    let active = true
    const unsubscribe = (): void => {
      if (!active) {
        return
      }
      active = false
      listeners!.delete(listener)
      if (listeners!.size === 0 && this.ptyExitListenersByPtyId.get(ptyId) === listeners) {
        this.ptyExitListenersByPtyId.delete(ptyId)
      }
    }
    listeners.add(listener)
    if (
      this.getPtyLifecycleGeneration(ptyId) !== lifecycleGeneration ||
      this.isPtyKnownExited(ptyId)
    ) {
      unsubscribe()
      listener()
    }
    return unsubscribe
  }

  /** Resolves once a registered PTY's exit reaches its runtime record; false on timeout. */
  waitForPtyExitRecord(ptyId: string, timeoutMs: number): Promise<boolean> {
    if (!this.ptysById.has(ptyId) || this.isPtyKnownExited(ptyId)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let unsubscribe = (): void => {}
      const timer = setTimeout(
        () => {
          unsubscribe()
          resolve(false)
        },
        Math.max(0, timeoutMs)
      )
      timer.unref?.()
      unsubscribe = this.subscribeToPtyExit(ptyId, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  protected rememberPtyLivenessVerdict(ptyId: string, verdict: PtyLivenessVerdict): void {
    // An earned death certificate is KEPT, not dropped, so the register is three-valued on disk as
    // well as in the type. Its only writer is a host-delivered exit frame; nothing weaker may
    // reach it (docs/reference/ssh-execution-boundary.md).
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.ptyLivenessObservationSequence += 1
    this.ptyLivenessVerdictByPtyId.set(ptyId, {
      verdict,
      observedAt: this.ptyLivenessObservationSequence
    })
    while (this.ptyLivenessVerdictByPtyId.size > MAX_TRACKED_PTY_LIVENESS_VERDICTS) {
      let oldestOrphaned: string | null = null
      for (const candidate of this.ptyLivenessVerdictByPtyId.keys()) {
        if (
          !this.ptysById.has(candidate) &&
          !this.handleByPtyId.has(candidate) &&
          !this.leafExistsForPty(candidate)
        ) {
          oldestOrphaned = candidate
          break
        }
      }
      if (!oldestOrphaned) {
        return
      }
      this.ptyLivenessVerdictByPtyId.delete(oldestOrphaned)
    }
  }

  protected forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void {
    const tracked = this.ptyLivenessVerdictByPtyId.get(ptyId)
    // An inventory's weak absence cannot revoke an earlier host-certified exit.
    if (tracked?.verdict.status === 'exited') {
      return
    }
    if (observedNoLaterThan !== undefined && tracked && tracked.observedAt > observedNoLaterThan) {
      return
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
  }

  // ─── Driver state (mobile-presence lock) ──────────────────────────
  //
  // See docs/mobile-presence-lock.md.

  getDriver(
    ...args: Parameters<TerminalLayoutCommands['getDriver']>
  ): ReturnType<TerminalLayoutCommands['getDriver']> {
    return this.terminalLayout.commands.getDriver(...args)
  }

  protected setDriver(
    ...args: Parameters<TerminalLayoutCommands['setDriver']>
  ): ReturnType<TerminalLayoutCommands['setDriver']> {
    return this.terminalLayout.commands.setDriver(...args)
  }

  // Why: the host's own fit cascade (window resize, split drag, tab reveal,
  // "+"-new-tab re-render) must not resize a PTY whose width a remote client
  // owns — that is the remote "porridge" bug. True while a phone (mobile driver)
  // OR an active remote desktop viewer owns the PTY. Input is deliberately NOT gated
  // here (see the `writePtyInput` mobile-only checks): shared-control desktop
  // viewers may still type alongside the host.
  // Note: this is intentionally NOT a driver kind. An active remote viewer needs
  // only resize suppression, not the mobile driver machinery (input lock,
  // phone-fit, driver-change banners), so it lives in its own registry and does
  // not perturb the presence-lock state machine. It also coexists with mobile:
  // while a phone drives, the registry still suppresses host resize, and when
  // the phone leaves the surviving viewer keeps the PTY suppressed.
  isPtyResizeDrivenRemotely(
    ...args: Parameters<TerminalLayoutCommands['isPtyResizeDrivenRemotely']>
  ): ReturnType<TerminalLayoutCommands['isPtyResizeDrivenRemotely']> {
    return this.terminalLayout.commands.isPtyResizeDrivenRemotely(...args)
  }

  isRemoteDesktopResizeDriven(
    ...args: Parameters<TerminalLayoutCommands['isRemoteDesktopResizeDriven']>
  ): ReturnType<TerminalLayoutCommands['isRemoteDesktopResizeDriven']> {
    return this.terminalLayout.commands.isRemoteDesktopResizeDriven(...args)
  }

  isRemoteDesktopViewerOwner(
    ...args: Parameters<TerminalLayoutCommands['isRemoteDesktopViewerOwner']>
  ): ReturnType<TerminalLayoutCommands['isRemoteDesktopViewerOwner']> {
    return this.terminalLayout.commands.isRemoteDesktopViewerOwner(...args)
  }

  getRemoteDesktopFitHold(
    ...args: Parameters<TerminalLayoutCommands['getRemoteDesktopFitHold']>
  ): ReturnType<TerminalLayoutCommands['getRemoteDesktopFitHold']> {
    return this.terminalLayout.commands.getRemoteDesktopFitHold(...args)
  }

  recordRemoteDesktopHostReclaimTarget(
    ...args: Parameters<TerminalLayoutCommands['recordRemoteDesktopHostReclaimTarget']>
  ): ReturnType<TerminalLayoutCommands['recordRemoteDesktopHostReclaimTarget']> {
    return this.terminalLayout.commands.recordRemoteDesktopHostReclaimTarget(...args)
  }

  applyRemoteDesktopLayout(
    ...args: Parameters<TerminalLayoutCommands['applyRemoteDesktopLayout']>
  ): ReturnType<TerminalLayoutCommands['applyRemoteDesktopLayout']> {
    return this.terminalLayout.commands.applyRemoteDesktopLayout(...args)
  }

  // Why: attachment only records geometry. Passive hydration/reconnect must not
  // steal the shared PTY from the desktop where the user is actively working.
  updateRemoteDesktopViewer(
    ...args: Parameters<TerminalLayoutCommands['updateRemoteDesktopViewer']>
  ): ReturnType<TerminalLayoutCommands['updateRemoteDesktopViewer']> {
    return this.terminalLayout.commands.updateRemoteDesktopViewer(...args)
  }

  claimRemoteDesktopViewer(
    ...args: Parameters<TerminalLayoutCommands['claimRemoteDesktopViewer']>
  ): ReturnType<TerminalLayoutCommands['claimRemoteDesktopViewer']> {
    return this.terminalLayout.commands.claimRemoteDesktopViewer(...args)
  }

  claimRemoteDesktopHost(
    ...args: Parameters<TerminalLayoutCommands['claimRemoteDesktopHost']>
  ): ReturnType<TerminalLayoutCommands['claimRemoteDesktopHost']> {
    return this.terminalLayout.commands.claimRemoteDesktopHost(...args)
  }

  noteRemoteDesktopHostInput(
    ...args: Parameters<TerminalLayoutCommands['noteRemoteDesktopHostInput']>
  ): ReturnType<TerminalLayoutCommands['noteRemoteDesktopHostInput']> {
    return this.terminalLayout.commands.noteRemoteDesktopHostInput(...args)
  }

  unregisterRemoteDesktopViewer(
    ...args: Parameters<TerminalLayoutCommands['unregisterRemoteDesktopViewer']>
  ): ReturnType<TerminalLayoutCommands['unregisterRemoteDesktopViewer']> {
    return this.terminalLayout.commands.unregisterRemoteDesktopViewer(...args)
  }

  unregisterRemoteDesktopViewers(
    ...args: Parameters<TerminalLayoutCommands['unregisterRemoteDesktopViewers']>
  ): ReturnType<TerminalLayoutCommands['unregisterRemoteDesktopViewers']> {
    return this.terminalLayout.commands.unregisterRemoteDesktopViewers(...args)
  }

  // Why: the one-shot `terminal.updateViewport` RPC has no disconnect hook, so
  // it must never *create* a width floor (that floor would leak — nothing
  // releases it, pinning the host at a stale width after the viewer is gone).
  // It only refreshes the floor(s) this client already owns via its stream
  // subscription, keyed by clientId. Mirrors the mobile `updateMobileViewport`
  // no-op-without-subscription invariant. Returns false when the client owns no
  // floor (passive/stream-less viewer) — a stream-less viewer must not lock host
  // resize.
  refreshRemoteDesktopViewer(
    ...args: Parameters<TerminalLayoutCommands['refreshRemoteDesktopViewer']>
  ): ReturnType<TerminalLayoutCommands['refreshRemoteDesktopViewer']> {
    return this.terminalLayout.commands.refreshRemoteDesktopViewer(...args)
  }

  updateDesktopViewport(
    ...args: Parameters<TerminalLayoutCommands['updateDesktopViewport']>
  ): ReturnType<TerminalLayoutCommands['updateDesktopViewport']> {
    return this.terminalLayout.commands.updateDesktopViewport(...args)
  }

  markMobileActor(
    ...args: Parameters<TerminalLayoutCommands['markMobileActor']>
  ): ReturnType<TerminalLayoutCommands['markMobileActor']> {
    return this.terminalLayout.commands.markMobileActor(...args)
  }

  beginMobileInputFloor(
    ...args: Parameters<TerminalLayoutCommands['beginMobileInputFloor']>
  ): ReturnType<TerminalLayoutCommands['beginMobileInputFloor']> {
    return this.terminalLayout.commands.beginMobileInputFloor(...args)
  }

  mobileTookFloor(
    ...args: Parameters<TerminalLayoutCommands['mobileTookFloor']>
  ): ReturnType<TerminalLayoutCommands['mobileTookFloor']> {
    return this.terminalLayout.commands.mobileTookFloor(...args)
  }

  updateMobileViewport(
    ...args: Parameters<TerminalLayoutCommands['updateMobileViewport']>
  ): ReturnType<TerminalLayoutCommands['updateMobileViewport']> {
    return this.terminalLayout.commands.updateMobileViewport(...args)
  }

  reclaimTerminalForDesktop(
    ...args: Parameters<TerminalLayoutCommands['reclaimTerminalForDesktop']>
  ): ReturnType<TerminalLayoutCommands['reclaimTerminalForDesktop']> {
    return this.terminalLayout.commands.reclaimTerminalForDesktop(...args)
  }

  protected cancelPendingDriverMutations(
    ...args: Parameters<TerminalLayoutCommands['cancelPendingDriverMutations']>
  ): ReturnType<TerminalLayoutCommands['cancelPendingDriverMutations']> {
    return this.terminalLayout.commands.cancelPendingDriverMutations(...args)
  }

  protected releaseDesktopTakeBack(
    ...args: Parameters<TerminalLayoutCommands['releaseDesktopTakeBack']>
  ): ReturnType<TerminalLayoutCommands['releaseDesktopTakeBack']> {
    return this.terminalLayout.commands.releaseDesktopTakeBack(...args)
  }

  protected getAutoRestoreFitMs(
    ...args: Parameters<TerminalLayoutCommands['getAutoRestoreFitMs']>
  ): ReturnType<TerminalLayoutCommands['getAutoRestoreFitMs']> {
    return this.terminalLayout.commands.getAutoRestoreFitMs(...args)
  }

  cancelAllPendingFitRestoreTimers(
    ...args: Parameters<TerminalLayoutCommands['cancelAllPendingFitRestoreTimers']>
  ): ReturnType<TerminalLayoutCommands['cancelAllPendingFitRestoreTimers']> {
    return this.terminalLayout.commands.cancelAllPendingFitRestoreTimers(...args)
  }

  getMobileAutoRestoreFitMs(
    ...args: Parameters<TerminalLayoutCommands['getMobileAutoRestoreFitMs']>
  ): ReturnType<TerminalLayoutCommands['getMobileAutoRestoreFitMs']> {
    return this.terminalLayout.commands.getMobileAutoRestoreFitMs(...args)
  }

  setMobileAutoRestoreFitMs(
    ...args: Parameters<TerminalLayoutCommands['setMobileAutoRestoreFitMs']>
  ): ReturnType<TerminalLayoutCommands['setMobileAutoRestoreFitMs']> {
    return this.terminalLayout.commands.setMobileAutoRestoreFitMs(...args)
  }

  protected pickMostRecentActor(
    ...args: Parameters<TerminalLayoutCommands['pickMostRecentActor']>
  ): ReturnType<TerminalLayoutCommands['pickMostRecentActor']> {
    return this.terminalLayout.commands.pickMostRecentActor(...args)
  }

  protected pickEarliestRestoreTarget(
    ...args: Parameters<TerminalLayoutCommands['pickEarliestRestoreTarget']>
  ): ReturnType<TerminalLayoutCommands['pickEarliestRestoreTarget']> {
    return this.terminalLayout.commands.pickEarliestRestoreTarget(...args)
  }

  getLayout(
    ...args: Parameters<TerminalLayoutCommands['getLayout']>
  ): ReturnType<TerminalLayoutCommands['getLayout']> {
    return this.terminalLayout.commands.getLayout(...args)
  }

  protected isFreshSubscribe(
    ...args: Parameters<TerminalLayoutCommands['isFreshSubscribe']>
  ): ReturnType<TerminalLayoutCommands['isFreshSubscribe']> {
    return this.terminalLayout.commands.isFreshSubscribe(...args)
  }

  protected resolveDesktopRestoreTarget(
    ...args: Parameters<TerminalLayoutCommands['resolveDesktopRestoreTarget']>
  ): ReturnType<TerminalLayoutCommands['resolveDesktopRestoreTarget']> {
    return this.terminalLayout.commands.resolveDesktopRestoreTarget(...args)
  }

  protected coalescesWith(
    ...args: Parameters<TerminalLayoutCommands['coalescesWith']>
  ): ReturnType<TerminalLayoutCommands['coalescesWith']> {
    return this.terminalLayout.commands.coalescesWith(...args)
  }

  protected enqueueLayout(
    ...args: Parameters<TerminalLayoutCommands['enqueueLayout']>
  ): ReturnType<TerminalLayoutCommands['enqueueLayout']> {
    return this.terminalLayout.commands.enqueueLayout(...args)
  }

  protected runLayoutSlot(
    ...args: Parameters<TerminalLayoutCommands['runLayoutSlot']>
  ): ReturnType<TerminalLayoutCommands['runLayoutSlot']> {
    return this.terminalLayout.commands.runLayoutSlot(...args)
  }
}
