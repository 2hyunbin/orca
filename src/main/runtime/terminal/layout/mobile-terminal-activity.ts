import type { TerminalLayoutContext } from './terminal-layout-context'
import type { ApplyLayoutResult, DriverState } from '../../orca-runtime-core'
import { clampTerminalViewport } from '../../terminal-viewport'

export async function mobileTookFloor(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  previousFloor?: DriverState,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  const sub = inner?.get(clientId)
  const softLeaver = ctx.state.pendingSoftLeavers.get(ptyId)
  // Why: native chat pauses terminal output, so its later sends have no
  // subscriber lifecycle that could release a newly-created desktop lock.
  if (!sub && softLeaver?.clientId !== clientId) {
    return
  }
  if (sub) {
    sub.lastActedAt = Date.now()
  }
  const prev = previousFloor ?? ctx.commands.getDriver(ptyId)
  const currentMode = ctx.state.mobileDisplayModes.get(ptyId)
  // Why: a deliberate mobile action implies mobile is resuming control.
  // If the display mode is currently 'desktop' (set by an earlier
  // take-back), flip it back to 'auto' (= map absence) and re-apply so
  // phone-fit takes hold again. See docs/mobile-presence-lock.md.
  if (prev.kind === 'desktop' || currentMode === 'desktop') {
    if (currentMode === 'desktop') {
      ctx.state.mobileDisplayModes.delete(ptyId)
    }
    await ctx.commands.applyMobileDisplayMode(ptyId)
  }
  // Why: display changes are async; a later PTY write must keep the floor
  // when an older phone-fit operation eventually completes.
  if (!isCurrent()) {
    return
  }
  ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId })
}

export async function updateMobileViewport(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  viewport: { cols: number; rows: number }
): Promise<{ updated: boolean; applied: boolean }> {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  const sub = inner?.get(clientId)
  if (!sub) {
    return { updated: false, applied: false }
  }
  sub.viewport = viewport
  sub.lastActedAt = Date.now()

  const mode = ctx.commands.getMobileDisplayMode(ptyId)
  if (mode === 'desktop') {
    // Watching at desktop dims — viewport is informational only.
    return { updated: true, applied: false }
  }
  if (ctx.commands.getDriver(ptyId).kind === 'desktop') {
    return { updated: true, applied: false }
  }
  // Drive PTY dims by the most-recent-actor (just updated to this client).
  const winner = ctx.commands.pickMostRecentActor(inner!)
  if (!winner) {
    return { updated: false, applied: false }
  }
  const winnerSub = inner!.get(winner.clientId)
  const driveViewport = winnerSub?.viewport ?? viewport
  const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
    driveViewport.cols,
    driveViewport.rows
  )

  sub.wasResizedToPhone = true
  // The driver is already mobile{this client} when we got here; refresh
  // to update lastActedAt-based ordering on later actor selection.
  ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId })

  const needsFreshSubscribeGuard = !ctx.state.layouts.has(ptyId)
  if (needsFreshSubscribeGuard) {
    ctx.state.freshSubscribeGuard.add(ptyId)
  }
  let result: ApplyLayoutResult
  try {
    result = await ctx.commands.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: clampedCols,
      rows: clampedRows,
      ownerClientId: winner.clientId
    })
  } finally {
    if (needsFreshSubscribeGuard) {
      ctx.state.freshSubscribeGuard.delete(ptyId)
    }
  }
  return { updated: true, applied: result.ok }
}
