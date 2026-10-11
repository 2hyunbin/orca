import type { TerminalLayoutContext } from './terminal-layout-context'

export function handleMobileUnsubscribe(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string
): void {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  if (!inner) {
    return
  }
  const subscriber = inner.get(clientId)
  if (!subscriber) {
    return
  }
  const wasResizedToPhone = subscriber.wasResizedToPhone

  inner.delete(clientId)
  ctx.commands.notifyRemoteTerminalViewPresenceChanged(ptyId)

  if (inner.size > 0) {
    // Why: if the leaving client was the only one with a non-null restore
    // baseline (typical when peer joiners subscribed against an
    // already-phone-fitted PTY and got null prevCols), donate the baseline
    // to the earliest surviving subscriber so a future last-leaver can
    // still restore correctly. See docs/mobile-presence-lock.md.
    if (
      subscriber.previousCols != null &&
      subscriber.previousRows != null &&
      !ctx.commands.pickEarliestRestoreTarget(inner)
    ) {
      let earliestSurvivor: { clientId: string; subscribedAt: number } | null = null
      for (const sub of inner.values()) {
        if (earliestSurvivor === null || sub.subscribedAt < earliestSurvivor.subscribedAt) {
          earliestSurvivor = { clientId: sub.clientId, subscribedAt: sub.subscribedAt }
        }
      }
      if (earliestSurvivor) {
        const heir = inner.get(earliestSurvivor.clientId)
        if (heir) {
          heir.previousCols = subscriber.previousCols
          heir.previousRows = subscriber.previousRows
        }
      }
    }
    // Peers still on the line. If the disconnecting client was the active
    // mobile driver, re-elect the most-recent surviving subscriber so the
    // banner remains correct and active phone-fit dims follow them.
    const driver = ctx.commands.getDriver(ptyId)
    if (driver.kind === 'mobile' && driver.clientId === clientId) {
      const next = ctx.commands.pickMostRecentActor(inner)
      if (next) {
        ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })
        // Fire-and-forget — handleMobileUnsubscribe stays sync; applyLayout
        // failures self-recover on the next gesture.
        void ctx.commands.applyMobileDisplayMode(ptyId)
      }
    }
    return
  }

  // Last subscriber leaving — clean up.
  ctx.state.mobileSubscribers.delete(ptyId)
  const mode = ctx.commands.getMobileDisplayMode(ptyId)

  // Resubscribe-grace: hold driver=mobile{clientId} for ~250ms so a quick
  // re-subscribe (older clients without updateViewport) doesn't flash the
  // desktop banner. See docs/mobile-presence-lock.md.
  const SOFT_LEAVE_GRACE_MS = 250
  const existingSoft = ctx.state.pendingSoftLeavers.get(ptyId)
  if (existingSoft) {
    clearTimeout(existingSoft.timer)
    ctx.state.pendingSoftLeavers.delete(ptyId)
  }
  const softTimer = setTimeout(() => {
    ctx.state.pendingSoftLeavers.delete(ptyId)
    if (!ctx.state.mobileSubscribers.has(ptyId)) {
      ctx.commands.setDriver(ptyId, { kind: 'idle' })
      if (ctx.remoteDesktopFloor.hasViewers(ptyId)) {
        void ctx.commands.applyRemoteDesktopLayout(ptyId)
      }
    }
  }, SOFT_LEAVE_GRACE_MS)
  if (typeof softTimer.unref === 'function') {
    softTimer.unref()
  }
  ctx.state.pendingSoftLeavers.set(ptyId, {
    clientId,
    timer: softTimer,
    record: {
      clientId: subscriber.clientId,
      viewport: subscriber.viewport,
      wasResizedToPhone: subscriber.wasResizedToPhone,
      previousCols: subscriber.previousCols,
      previousRows: subscriber.previousRows,
      subscribedAt: subscriber.subscribedAt,
      lastActedAt: subscriber.lastActedAt
    }
  })

  if (mode === 'auto' && wasResizedToPhone) {
    const existingTimer = ctx.state.pendingRestoreTimers.get(ptyId)
    if (existingTimer) {
      clearTimeout(existingTimer.timer)
      ctx.state.pendingRestoreTimers.delete(ptyId)
    }
    // Why: scheduling is conditional on the user's mobileAutoRestoreFitMs
    // preference. `null` (default, "Indefinite") leaves the PTY at phone
    // dims until the user clicks Restore on the desktop banner — the
    // central UX promise of docs/mobile-fit-hold.md. A finite value runs
    // the restore that long after the last unsubscribe.
    const autoRestoreMs = ctx.commands.getAutoRestoreFitMs()
    if (autoRestoreMs == null) {
      // Indefinite hold: the fit override persists, the SOFT_LEAVE_GRACE
      // driver-state grace above still releases the input lock, and the
      // banner's Restore button is the explicit return path.
    } else {
      // Snapshot the disconnecting subscriber's baseline NOW, before the
      // timer fires. By the time the timer runs, the subscriber map has
      // been deleted; resolveDesktopRestoreTarget would fall through to
      // lastRendererSizes → current PTY size (which is at phone dims,
      // wrong). The disconnecting subscriber's baseline is the correct
      // restore target.
      const fallback = ctx.state.lastRendererSizes.get(ptyId)
      const restoreCols =
        subscriber.previousCols ?? fallback?.cols ?? ctx.host.getTerminalSize(ptyId)?.cols ?? 80
      const restoreRows =
        subscriber.previousRows ?? fallback?.rows ?? ctx.host.getTerminalSize(ptyId)?.rows ?? 24
      const timer = setTimeout(() => {
        ctx.state.pendingRestoreTimers.delete(ptyId)
        if (ctx.commands.isMobileSubscriberActive(ptyId)) {
          return
        }
        if (ctx.remoteDesktopFloor.hasLayoutState(ptyId)) {
          void ctx.commands.applyRemoteDesktopLayout(ptyId)
          return
        }
        void ctx.commands.enqueueLayout(ptyId, {
          kind: 'desktop',
          cols: restoreCols,
          rows: restoreRows
        })
      }, autoRestoreMs)
      // Why: a delayed mobile restore should not keep Electron main alive
      // after the last window/runtime transport has otherwise shut down.
      if (typeof timer.unref === 'function') {
        timer.unref()
      }

      ctx.state.pendingRestoreTimers.set(ptyId, { timer, clientId })
    }
  }
  // 'desktop' mode: was never resized, nothing to restore.
}
