import type { TerminalLayoutContext } from './terminal-layout-context'
import type { ApplyLayoutResult, PtyLayoutState, PtyLayoutTarget } from '../../orca-runtime-core'

export async function applyLayout(
  ctx: TerminalLayoutContext,
  ptyId: string,
  target: PtyLayoutTarget
): Promise<ApplyLayoutResult> {
  // Why: re-check pty-exit at the head of the slot — the queue may have
  // accepted this target before onPtyExit ran.
  if (!ctx.state.layouts.has(ptyId) && !ctx.commands.isFreshSubscribe(ptyId)) {
    return { ok: false, reason: 'pty-exited' }
  }

  const prev = ctx.state.layouts.get(ptyId) ?? null
  const seq = (prev?.seq ?? 0) + 1
  const next: PtyLayoutState = { ...target, seq, appliedAt: Date.now() }

  const currentSize = ctx.host.getTerminalSize(ptyId)
  const dimsChanged = currentSize?.cols !== target.cols || currentSize?.rows !== target.rows
  const modeChanged = (prev?.kind ?? 'desktop') !== target.kind

  // Snapshot for rollback.
  const prevFitOverride = ctx.state.terminalFitOverrides.get(ptyId) ?? null

  // Tentative writes — the resize is the point of no return.
  ctx.state.layouts.set(ptyId, next)
  if (target.kind === 'phone') {
    // Why: pull baseline cols+rows atomically from the same subscriber so
    // they can't desync.
    const baseline = (() => {
      const inner = ctx.state.mobileSubscribers.get(ptyId)
      if (!inner) {
        return null
      }
      return ctx.commands.pickEarliestRestoreTarget(inner)
    })()
    ctx.state.terminalFitOverrides.set(ptyId, {
      mode: 'mobile-fit',
      cols: target.cols,
      rows: target.rows,
      previousCols: baseline?.previousCols ?? null,
      previousRows: baseline?.previousRows ?? null,
      updatedAt: next.appliedAt,
      clientId: target.ownerClientId
    })
  } else {
    ctx.state.terminalFitOverrides.delete(ptyId)
  }

  if (dimsChanged) {
    let ok = false
    try {
      const r = ctx.host.getPtyController()?.resize?.(ptyId, target.cols, target.rows)
      ok = r ?? true
    } catch (err) {
      console.error('[layout] ptyController.resize threw', { ptyId, err })
      ok = false
    }
    if (!ok) {
      // Roll back to pre-call snapshot. seq is NOT bumped on the wire
      // because we never emit below.
      if (prev) {
        ctx.state.layouts.set(ptyId, prev)
      } else {
        ctx.state.layouts.delete(ptyId)
      }
      if (prevFitOverride) {
        ctx.state.terminalFitOverrides.set(ptyId, prevFitOverride)
      } else {
        ctx.state.terminalFitOverrides.delete(ptyId)
      }
      return { ok: false, reason: 'resize-failed' }
    }
    ctx.host.resizeHeadlessTerminal(ptyId, target.cols, target.rows)
  }

  // Why: remote desktop ownership is a fit hold for the host and passive
  // peer viewers. Emit every remote layout so owner changes at equal geometry
  // still park/release the correct clients without relying on resize deltas.
  // Defense-in-depth (#7588): also emit when the override's presence
  // changed even without a kind flip. applyLayout is the sole writer and
  // keeps override presence in lockstep with layout kind, so overrideChanged
  // ≡ modeChanged in every reachable state today; the extra clause fires
  // only if that invariant is ever violated, repairing the renderer instead
  // of stranding the held modal.
  const overrideChanged = (prevFitOverride != null) !== (target.kind === 'phone')
  if (target.kind === 'remote-desktop' || modeChanged || overrideChanged) {
    // Why: phone→desktop arms the renderer-cascade suppress window
    // before the collateral safeFit IPCs arrive. See "Renderer cascade
    // suppression".
    if (target.kind === 'desktop') {
      ctx.state.lastRendererSizes.delete(ptyId)
      ctx.commands.suppressResizesForMs(500)
    }
    ctx.host
      .getNotifier()
      ?.terminalFitOverrideChanged(
        ptyId,
        target.kind === 'phone'
          ? 'mobile-fit'
          : target.kind === 'remote-desktop'
            ? 'remote-desktop-fit'
            : 'desktop-fit',
        target.cols,
        target.rows
      )
    ctx.commands.notifyFitOverrideListeners(
      ptyId,
      target.kind === 'phone'
        ? 'mobile-fit'
        : target.kind === 'remote-desktop'
          ? 'remote-desktop-fit'
          : 'desktop-fit',
      target.cols,
      target.rows
    )
  }

  // Mobile-facing event always fires (phone clients need to re-fit on
  // every dim change, not just mode flips).
  ctx.commands.notifyTerminalResize(ptyId, {
    cols: target.cols,
    rows: target.rows,
    displayMode: target.kind === 'phone' ? 'phone' : 'desktop',
    reason: 'apply-layout',
    seq
  })

  return { ok: true, state: next }
}

export function setMobileDisplayMode(
  ctx: TerminalLayoutContext,
  ptyId: string,
  mode: 'auto' | 'desktop'
): void {
  if (mode === 'auto') {
    ctx.state.mobileDisplayModes.delete(ptyId)
  } else {
    ctx.state.mobileDisplayModes.set(ptyId, mode)
  }
}

export function getMobileDisplayMode(
  ctx: TerminalLayoutContext,
  ptyId: string
): 'auto' | 'desktop' {
  return ctx.state.mobileDisplayModes.get(ptyId) ?? 'auto'
}

export function isMobileSubscriberActive(ctx: TerminalLayoutContext, ptyId: string): boolean {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  return inner !== undefined && inner.size > 0
}

export function updateMobileSubscriberViewport(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  viewport: { cols: number; rows: number }
): void {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  const record = inner?.get(clientId)
  if (!record) {
    return
  }
  record.viewport = viewport
}
