import type { TerminalLayoutContext } from './terminal-layout-context'

export function clearPtyMobilePresence(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.state.mobileSubscribers.delete(ptyId)
  ctx.viewSubscribers.clearSubscribers(ptyId)
  ctx.state.mobileDisplayModes.delete(ptyId)
  ctx.state.resizeListeners.delete(ptyId)
  ctx.state.lastRendererSizes.delete(ptyId)
}

export function retirePtyLayoutQueue(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.state.layouts.delete(ptyId)
  ctx.state.layoutQueues.delete(ptyId)
  ctx.state.freshSubscribeGuard.delete(ptyId)
  ctx.commands.cancelPendingDriverMutations(ptyId)
}

export function releaseExitedPtyFitOverride(ctx: TerminalLayoutContext, ptyId: string): void {
  if (ctx.state.terminalFitOverrides.has(ptyId)) {
    ctx.state.terminalFitOverrides.delete(ptyId)
    ctx.host.getNotifier()?.terminalFitOverrideChanged(ptyId, 'desktop-fit', 0, 0)
    ctx.commands.notifyFitOverrideListeners(ptyId, 'desktop-fit', 0, 0)
  }
}

export function clearExitedPtyFloors(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.drivers.clear(ptyId)
  ctx.remoteDesktopFloor.clearPty(ptyId)
}

export function markTerminalSpawnPublished(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.viewSubscribers.markSpawnPublished(ptyId)
}

export function resetTerminalViewGeneration(ctx: TerminalLayoutContext, ptyId: string): void {
  ctx.viewSubscribers.resetGeneration(ptyId)
}

export function notifyRemoteTerminalViewPresenceChanged(
  ctx: TerminalLayoutContext,
  ptyId: string
): void {
  ctx.host.notifyRemoteTerminalViewPresenceChanged(ptyId)
}
