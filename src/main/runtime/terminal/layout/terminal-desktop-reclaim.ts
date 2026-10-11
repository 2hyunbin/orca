import type { TerminalLayoutContext } from './terminal-layout-context'

import {
  MOBILE_AUTO_RESTORE_FIT_MAX_MS,
  MOBILE_AUTO_RESTORE_FIT_MIN_MS
} from '../../orca-runtime-postlude'

export async function reclaimTerminalForDesktop(
  ctx: TerminalLayoutContext,
  ptyId: string
): Promise<boolean> {
  ctx.commands.cancelPendingDriverMutations(ptyId)
  if (ctx.commands.isMobileSubscriberActive(ptyId)) {
    ctx.commands.setMobileDisplayMode(ptyId, 'desktop')
    await ctx.commands.applyMobileDisplayMode(ptyId)
    ctx.commands.releaseDesktopTakeBack(ptyId)
    // Why: a desktop-initiated reclaim is "I'm taking over right now", not a
    // sticky preference. The next mobile subscribe (e.g. user switches back to
    // the terminal tab on the phone) must default to phone-fit again, not stay
    // in passive desktop-watch mode.
    ctx.commands.setMobileDisplayMode(ptyId, 'auto')
    if (ctx.remoteDesktopFloor.hasLayoutState(ptyId)) {
      await ctx.commands.applyRemoteDesktopLayout(ptyId)
    }
    return true
  }
  const heldOverride = ctx.state.terminalFitOverrides.get(ptyId)
  if (heldOverride && ctx.remoteDesktopFloor.hasLayoutState(ptyId)) {
    const pending = ctx.state.pendingRestoreTimers.get(ptyId)
    if (pending) {
      clearTimeout(pending.timer)
      ctx.state.pendingRestoreTimers.delete(ptyId)
    }
    const softLeaver = ctx.state.pendingSoftLeavers.get(ptyId)
    if (softLeaver) {
      clearTimeout(softLeaver.timer)
      ctx.state.pendingSoftLeavers.delete(ptyId)
    }
    ctx.commands.setDriver(ptyId, { kind: 'idle' })
    const converged = await ctx.commands.applyRemoteDesktopLayout(ptyId)
    if (!converged) {
      // Explicit take-back always clears the lock; resize convergence is
      // best-effort and the desktop renderer will retry on its next frame.
      ctx.commands.releaseDesktopTakeBack(ptyId)
      ctx.commands.setMobileDisplayMode(ptyId, 'auto')
      return true
    }
    ctx.commands.setDriver(ptyId, { kind: 'desktop' })
    ctx.commands.setMobileDisplayMode(ptyId, 'auto')
    return true
  }
  if (heldOverride) {
    // Why: with no subscribers, resolveDesktopRestoreTarget can fall through
    // to current PTY size — which is at phone dims (wrong). Prefer a fresh
    // desktop renderer measurement when one exists; otherwise use the
    // override's pre-fit baseline before falling back to current size.
    const fallback = ctx.commands.resolveDesktopRestoreTarget(ptyId)
    const renderer = ctx.state.lastRendererSizes.get(ptyId)
    const cols = renderer?.cols ?? heldOverride.previousCols ?? fallback.cols
    const rows = renderer?.rows ?? heldOverride.previousRows ?? fallback.rows
    await ctx.commands.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    ctx.commands.releaseDesktopTakeBack(ptyId)
    ctx.commands.setMobileDisplayMode(ptyId, 'auto')
    return true
  }
  // Why: a stale lock — driver still reads mobile with no active subscriber
  // and no held override (e.g. reclaimed inside the soft-leave grace, or a
  // subscriber that dropped without a clean unsubscribe). Release it so the
  // banner can't linger; there is nothing to resize.
  if (ctx.commands.getDriver(ptyId).kind === 'mobile') {
    ctx.commands.releaseDesktopTakeBack(ptyId)
    return true
  }
  return false
}

export function cancelPendingDriverMutations(ctx: TerminalLayoutContext, ptyId: string): void {
  const pendingRestore = ctx.state.pendingRestoreTimers.get(ptyId)
  if (pendingRestore) {
    clearTimeout(pendingRestore.timer)
    ctx.state.pendingRestoreTimers.delete(ptyId)
  }
  const pendingSoft = ctx.state.pendingSoftLeavers.get(ptyId)
  if (pendingSoft) {
    clearTimeout(pendingSoft.timer)
    ctx.state.pendingSoftLeavers.delete(ptyId)
  }
}

export function releaseDesktopTakeBack(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.commands.setDriver(ptyId, { kind: 'desktop' })
  if (ctx.state.terminalFitOverrides.has(ptyId)) {
    ctx.state.terminalFitOverrides.delete(ptyId)
    ctx.host.getNotifier()?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
    ctx.commands.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
  }
}

export function getAutoRestoreFitMs(ctx: TerminalLayoutContext): number | null {
  const raw = ctx.host.getStore()?.getSettings().mobileAutoRestoreFitMs ?? null
  if (raw == null) {
    return null
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null
  }
  return Math.min(Math.max(raw, MOBILE_AUTO_RESTORE_FIT_MIN_MS), MOBILE_AUTO_RESTORE_FIT_MAX_MS)
}

export function cancelAllPendingFitRestoreTimers(ctx: TerminalLayoutContext): void {
  for (const [, entry] of ctx.state.pendingRestoreTimers) {
    clearTimeout(entry.timer)
  }
  ctx.state.pendingRestoreTimers.clear()
}

export function getMobileAutoRestoreFitMs(ctx: TerminalLayoutContext): number | null {
  return ctx.commands.getAutoRestoreFitMs()
}

export function setMobileAutoRestoreFitMs(
  ctx: TerminalLayoutContext,
  ms: number | null
): number | null {
  const store = ctx.host.getStore()
  if (!store?.updateSettings) {
    return ctx.commands.getAutoRestoreFitMs()
  }
  let normalized: number | null
  if (ms == null) {
    normalized = null
  } else if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    normalized = null
  } else {
    normalized = Math.min(
      Math.max(ms, MOBILE_AUTO_RESTORE_FIT_MIN_MS),
      MOBILE_AUTO_RESTORE_FIT_MAX_MS
    )
  }
  store.updateSettings({ mobileAutoRestoreFitMs: normalized }, { notifyListeners: true })
  if (normalized == null) {
    ctx.commands.cancelAllPendingFitRestoreTimers()
  }
  return normalized
}
