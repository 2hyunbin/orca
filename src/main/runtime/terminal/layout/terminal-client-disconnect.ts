import type { TerminalLayoutContext } from './terminal-layout-context'

export function onClientDisconnected(ctx: TerminalLayoutContext, clientId: string): void {
  // (1) Cancel pending restore-debounce timers owned by this client.
  for (const [ptyId, entry] of ctx.state.pendingRestoreTimers) {
    if (entry.clientId === clientId) {
      clearTimeout(entry.timer)
      ctx.state.pendingRestoreTimers.delete(ptyId)
    }
  }

  // Disconnect finalizes soft leave immediately; reconnect grace no longer applies.
  for (const [ptyId, soft] of ctx.state.pendingSoftLeavers) {
    if (soft.clientId !== clientId) {
      continue
    }
    clearTimeout(soft.timer)
    ctx.state.pendingSoftLeavers.delete(ptyId)

    // Cancel any in-flight 300ms restore timer too — we'll handle it inline.
    const pending = ctx.state.pendingRestoreTimers.get(ptyId)
    if (pending) {
      clearTimeout(pending.timer)
      ctx.state.pendingRestoreTimers.delete(ptyId)
    }

    const cur = ctx.state.layouts.get(ptyId)
    // Why: Indefinite hold (mobileAutoRestoreFitMs == null) keeps the PTY
    // at phone dims after the phone disconnects; the desktop banner's
    // Restore button is the explicit return path. See
    // docs/mobile-fit-hold.md.
    if (ctx.remoteDesktopFloor.hasViewers(ptyId)) {
      ctx.commands.setDriver(ptyId, { kind: 'idle' })
      void ctx.commands.applyRemoteDesktopLayout(ptyId)
      continue
    } else if (cur?.kind === 'phone' && ctx.commands.getAutoRestoreFitMs() != null) {
      if (ctx.remoteDesktopFloor.hasHostReclaimTarget(ptyId)) {
        ctx.commands.setDriver(ptyId, { kind: 'idle' })
        void ctx.commands.applyRemoteDesktopLayout(ptyId)
        continue
      }
      // Use the soft-leaver's snapshot baseline as a hint, falling
      // through to resolveDesktopRestoreTarget for missing values.
      const fallback = ctx.commands.resolveDesktopRestoreTarget(ptyId)
      const cols = soft.record.previousCols ?? fallback.cols
      const rows = soft.record.previousRows ?? fallback.rows
      void ctx.commands.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
    ctx.commands.setDriver(ptyId, { kind: 'idle' })
  }

  // (3) Immediate restore for PTYs where this client was the last
  // mobile subscriber. With multi-mobile, peer subscribers keep the
  // floor; only when the inner map empties do we transition to desktop.
  const ptysWithSurvivingPeers: string[] = []
  const ptysToRestore: { ptyId: string; baseline: { cols: number; rows: number } | null }[] = []
  for (const [ptyId, inner] of ctx.state.mobileSubscribers) {
    const subscriber = inner.get(clientId)
    if (!subscriber) {
      continue
    }
    // Snapshot baseline before deleting — needed once mobileSubscribers
    // entry is gone for the resolveDesktopRestoreTarget chain.
    const baseline =
      subscriber.previousCols != null && subscriber.previousRows != null
        ? { cols: subscriber.previousCols, rows: subscriber.previousRows }
        : null
    inner.delete(clientId)
    ctx.commands.notifyRemoteTerminalViewPresenceChanged(ptyId)
    if (inner.size > 0) {
      ptysWithSurvivingPeers.push(ptyId)
    } else {
      ctx.state.mobileSubscribers.delete(ptyId)
      ptysToRestore.push({ ptyId, baseline })
    }
  }
  for (const { ptyId, baseline } of ptysToRestore) {
    const cur = ctx.state.layouts.get(ptyId)
    // Why: Indefinite hold gate — see soft-leaver branch above.
    if (ctx.remoteDesktopFloor.hasViewers(ptyId)) {
      ctx.commands.setDriver(ptyId, { kind: 'idle' })
      void ctx.commands.applyRemoteDesktopLayout(ptyId)
      continue
    } else if (cur?.kind === 'phone' && ctx.commands.getAutoRestoreFitMs() != null) {
      if (ctx.remoteDesktopFloor.hasHostReclaimTarget(ptyId)) {
        ctx.commands.setDriver(ptyId, { kind: 'idle' })
        void ctx.commands.applyRemoteDesktopLayout(ptyId)
        continue
      }
      const fallback = ctx.commands.resolveDesktopRestoreTarget(ptyId)
      const cols = baseline?.cols ?? fallback.cols
      const rows = baseline?.rows ?? fallback.rows
      void ctx.commands.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    }
    ctx.commands.setDriver(ptyId, { kind: 'idle' })
  }

  // (4) Driver re-election where peers survived. If the disconnecting
  // client was the active driver, the most-recent surviving actor takes
  // the floor.
  for (const ptyId of ptysWithSurvivingPeers) {
    const driver = ctx.commands.getDriver(ptyId)
    if (driver.kind !== 'mobile' || driver.clientId !== clientId) {
      continue
    }
    const inner = ctx.state.mobileSubscribers.get(ptyId)
    const next = inner ? ctx.commands.pickMostRecentActor(inner) : null
    if (!next) {
      continue
    }
    ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId: next.clientId })

    const mode = ctx.commands.getMobileDisplayMode(ptyId)
    if (mode === 'desktop') {
      continue
    }
    const nextSub = inner!.get(next.clientId)
    const nextViewport = nextSub?.viewport
    if (!nextViewport) {
      continue
    }
    void ctx.commands.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: nextViewport.cols,
      rows: nextViewport.rows,
      ownerClientId: next.clientId
    })
  }

  // (5) Legacy-callers fallback. Older mobile builds use resizeForClient
  // directly and never populate mobileSubscribers. For those PTYs the
  // override carries the owning clientId; restore the layout when the
  // owner disconnects. resolveDesktopRestoreTarget reads lastRendererSizes
  // (which the legacy mobile-fit branch stashes the pre-fit size into).
  for (const [ptyId, override] of ctx.state.terminalFitOverrides) {
    if (override.clientId !== clientId) {
      continue
    }
    if (ctx.state.mobileSubscribers.has(ptyId)) {
      continue
    }
    const cur = ctx.state.layouts.get(ptyId)
    if (cur?.kind !== 'phone') {
      continue
    }
    // Why: Indefinite hold gate — see soft-leaver branch above. Legacy
    // mobile clients (resizeForClient path) honor the same setting.
    if (ctx.commands.getAutoRestoreFitMs() == null) {
      continue
    }
    const fallback = ctx.commands.resolveDesktopRestoreTarget(ptyId)
    const cols = override.previousCols ?? fallback.cols
    const rows = override.previousRows ?? fallback.rows
    void ctx.commands.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
  }
}
