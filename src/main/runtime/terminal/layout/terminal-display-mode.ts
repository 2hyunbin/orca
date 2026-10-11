import type { TerminalLayoutContext } from './terminal-layout-context'

export async function applyMobileDisplayMode(
  ctx: TerminalLayoutContext,
  ptyId: string
): Promise<boolean> {
  const mode = ctx.commands.getMobileDisplayMode(ptyId)
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  const subscriber = inner ? ctx.commands.pickMostRecentActor(inner) : null
  const subscriberRecord = subscriber && inner ? inner.get(subscriber.clientId) : null

  if (mode === 'desktop') {
    // Reset wasResizedToPhone on every fitted subscriber so a future
    // toggle back to auto re-issues the resize. applyLayout owns the
    // actual PTY resize + override delete + renderer notify. Track which
    // subscribers we cleared so a failed resize can re-arm them.
    const clearedFitSubscribers = inner
      ? [...inner.values()].filter((sub) => sub.wasResizedToPhone)
      : []
    for (const sub of clearedFitSubscribers) {
      sub.wasResizedToPhone = false
    }
    const anyWasResized = clearedFitSubscribers.length > 0
    // Why (#7588): also restore when a fit-override is still held but no
    // subscriber carries wasResizedToPhone — e.g. a null-viewport resubscribe
    // after an indefinite hold resets the flag yet leaves the override,
    // stranding the desktop "phone size" modal. Reuse resolveDesktopRestoreTarget
    // (the same resolver the anyWasResized branch uses) so the two adjacent
    // restore paths can never resolve to different dims for the same state.
    if (anyWasResized || ctx.state.terminalFitOverrides.has(ptyId)) {
      const restore = ctx.commands.resolveDesktopRestoreTarget(ptyId)
      const result = await ctx.commands.enqueueLayout(ptyId, {
        kind: 'desktop',
        cols: restore.cols,
        rows: restore.rows
      })
      // Why (#7588): a failed resize rolls the override back (still held), so
      // re-arm the flags we cleared. Otherwise a later unsubscribe under a
      // finite mobileAutoRestoreFitMs would see wasResizedToPhone=false, skip
      // scheduling its auto-restore timer, and strand the held phone-fit.
      if (!result.ok) {
        for (const sub of clearedFitSubscribers) {
          sub.wasResizedToPhone = true
        }
      }
    } else {
      // Nothing was fitted or held — emit a mode-change resize event so
      // the mobile client still learns the toggle landed.
      const size = ctx.host.getTerminalSize(ptyId)
      ctx.commands.notifyTerminalResize(ptyId, {
        cols: size?.cols ?? 0,
        rows: size?.rows ?? 0,
        displayMode: 'desktop',
        reason: 'mode-change',
        seq: ctx.state.layouts.get(ptyId)?.seq
      })
    }
  } else {
    // mode === 'auto' — the only non-desktop mode after the 'phone'
    // (sticky-fit) collapse. Phone-fit if the active subscriber has a
    // viewport and we haven't already applied it.
    if (subscriberRecord && !subscriberRecord.wasResizedToPhone) {
      const viewport = subscriberRecord.viewport
      if (viewport) {
        await ctx.commands.handleMobileSubscribe(ptyId, subscriberRecord.clientId, viewport)
        // After a phone-fit an override IS held, so this reports false. The
        // auto branch is never reached from reclaim (it sets 'desktop'
        // first); computed here only to keep the post-condition uniform.
        return !ctx.state.terminalFitOverrides.has(ptyId)
      }
    }
    // Why: always emit the mode change even when no resize occurred — the
    // mobile client needs to learn the toggle landed even if dims didn't
    // actually change. Carry the current seq (or undefined if no layout
    // entry yet) so the mobile-side stale-event filter behaves correctly.
    const size = ctx.host.getTerminalSize(ptyId)
    ctx.commands.notifyTerminalResize(ptyId, {
      cols: size?.cols ?? 0,
      rows: size?.rows ?? 0,
      displayMode: 'auto',
      reason: 'mode-change',
      seq: ctx.state.layouts.get(ptyId)?.seq
    })
  }
  return !ctx.state.terminalFitOverrides.has(ptyId)
}

export function onExternalPtyResize(
  ctx: TerminalLayoutContext,
  ptyId: string,
  cols: number,
  rows: number
): void {
  // The pty:resize IPC handler is supposed to gate via `isResizeSuppressed`
  // before calling here, but defend against callers that don't.
  if (ctx.commands.isResizeSuppressed()) {
    return
  }
  // Why: while a mobile-fit override is in place, the desktop renderer's
  // safeFit echoes pty:resize(override.cols, override.rows). Treating that
  // echo as legitimate geometry would overwrite each subscriber's
  // previousCols/Rows baseline with phone dims, so the next take-back
  // enqueues a no-op {kind:'desktop', cols:49, rows:40} and leaves xterm
  // stuck. Only filter reports that EXACTLY match the override — a fresh
  // measurement from a now-visible pane (e.g. user activated a previously
  // hidden tab on desktop, container went 0×0 → 1782×1195) reports
  // different dims and is the right baseline to remember.
  const activeOverride = ctx.state.terminalFitOverrides.get(ptyId)
  if (activeOverride && activeOverride.cols === cols && activeOverride.rows === rows) {
    return
  }
  // Why: a successful host resize supersedes any target retained after a
  // failed viewer reclaim; a later viewer cycle must capture this new truth.
  ctx.remoteDesktopFloor.clearStaleHostReclaimTarget(ptyId)
  ctx.host.resizeHeadlessTerminal(ptyId, cols, rows)
  ctx.commands.refreshRendererGeometry(ptyId, cols, rows)
}

export function recordRendererGeometry(
  ctx: TerminalLayoutContext,
  ptyId: string,
  cols: number,
  rows: number
): void {
  if (cols <= 0 || rows <= 0) {
    return
  }
  // Why: a viewer may leave while phone-fit still owns the PTY. Keep its
  // deferred host reclaim cache aligned with later trusted pane measurements.
  ctx.remoteDesktopFloor.updateHostReclaimTarget(ptyId, cols, rows)
  ctx.commands.refreshRendererGeometry(ptyId, cols, rows)
}

export function getLastRendererSize(
  ctx: TerminalLayoutContext,
  ptyId: string
): { cols: number; rows: number } | null {
  return ctx.state.lastRendererSizes.get(ptyId) ?? null
}

export function refreshRendererGeometry(
  ctx: TerminalLayoutContext,
  ptyId: string,
  cols: number,
  rows: number
): void {
  ctx.state.lastRendererSizes.set(ptyId, { cols, rows })
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  if (!inner) {
    return
  }
  // Refresh the renderer-current size as the next-restore target on every
  // subscriber that already has a non-null baseline. Subscribers with null
  // baselines (joined while a peer had already phone-fitted) stay null.
  for (const sub of inner.values()) {
    if (sub.previousCols != null && sub.previousRows != null) {
      sub.previousCols = cols
      sub.previousRows = rows
    }
  }
}

export function isResizeSuppressed(ctx: TerminalLayoutContext): boolean {
  return Date.now() < ctx.state.resizeSuppressedUntil
}

export function suppressResizesForMs(ctx: TerminalLayoutContext, ms: number): void {
  ctx.state.resizeSuppressedUntil = Date.now() + ms
}
