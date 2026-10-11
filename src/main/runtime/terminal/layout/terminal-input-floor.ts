import type { TerminalLayoutContext } from './terminal-layout-context'
import type { DriverState } from '../../orca-runtime-core'

import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { isUntypedTerminalInput } from '../../terminal-run-facts'
import { clampTerminalViewport } from '../../terminal-viewport'

export function getDriver(ctx: TerminalLayoutContext, ptyId: string): DriverState {
  return ctx.drivers.get(ptyId)
}

export function setDriver(ctx: TerminalLayoutContext, ptyId: string, next: DriverState): void {
  ctx.drivers.set(ptyId, next)
}

export function isPtyResizeDrivenRemotely(ctx: TerminalLayoutContext, ptyId: string): boolean {
  if (ctx.commands.getDriver(ptyId).kind === 'mobile') {
    return true
  }
  return ctx.commands.isRemoteDesktopResizeDriven(ptyId)
}

export function isRemoteDesktopResizeDriven(ctx: TerminalLayoutContext, ptyId: string): boolean {
  return ctx.remoteDesktopFloor.isResizeDriven(ptyId)
}

export function isRemoteDesktopViewerOwner(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKey: string
): boolean {
  return ctx.remoteDesktopFloor.isViewerOwner(ptyId, subscriptionKey)
}

export function getRemoteDesktopFitHold(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKey: string
): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
  return ctx.remoteDesktopFloor.getFitHold(ptyId, subscriptionKey)
}

export function recordRemoteDesktopHostReclaimTarget(
  ctx: TerminalLayoutContext,
  ptyId: string,
  cols: number,
  rows: number
): void {
  ctx.remoteDesktopFloor.recordHostReclaimTarget(ptyId, cols, rows)
}

export async function applyRemoteDesktopLayout(
  ctx: TerminalLayoutContext,
  ptyId: string
): Promise<boolean> {
  return ctx.remoteDesktopFloor.applyLayout(ptyId)
}

export async function updateRemoteDesktopViewer(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKey: string,
  clientId: string,
  cols: number,
  rows: number,
  claim = true
): Promise<boolean> {
  return ctx.remoteDesktopFloor.updateViewer(ptyId, subscriptionKey, clientId, cols, rows, claim)
}

export function claimRemoteDesktopViewer(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKey: string
): Promise<boolean> {
  return ctx.remoteDesktopFloor.claimViewer(ptyId, subscriptionKey)
}

export function claimRemoteDesktopHost(
  ctx: TerminalLayoutContext,
  ptyId: string,
  cols: number,
  rows: number
): Promise<boolean> {
  return ctx.remoteDesktopFloor.claimHost(ptyId, cols, rows)
}

export function noteRemoteDesktopHostInput(
  ctx: TerminalLayoutContext,
  ptyId: string,
  inputKind: TerminalInputKind,
  data: string
): void {
  if (inputKind === 'driving' && !isUntypedTerminalInput(data)) {
    ctx.remoteDesktopFloor.noteHostInput(ptyId)
  }
}

export function unregisterRemoteDesktopViewer(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKey: string
): Promise<boolean> {
  return ctx.commands.unregisterRemoteDesktopViewers(ptyId, [subscriptionKey])
}

export function unregisterRemoteDesktopViewers(
  ctx: TerminalLayoutContext,
  ptyId: string,
  subscriptionKeys: Iterable<string>
): Promise<boolean> {
  return ctx.remoteDesktopFloor.unregisterViewers(ptyId, subscriptionKeys)
}

export function refreshRemoteDesktopViewer(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  cols: number,
  rows: number,
  claim = false
): Promise<boolean> {
  return ctx.remoteDesktopFloor.refreshViewer(ptyId, clientId, cols, rows, claim)
}

export async function updateDesktopViewport(
  ctx: TerminalLayoutContext,
  ptyId: string,
  viewport: { cols: number; rows: number }
): Promise<boolean> {
  const { cols, rows } = clampTerminalViewport(viewport.cols, viewport.rows)
  if (
    ctx.state.terminalFitOverrides.has(ptyId) ||
    ctx.commands.getDriver(ptyId).kind === 'mobile'
  ) {
    ctx.commands.recordRendererGeometry(ptyId, cols, rows)
    return true
  }
  if (ctx.commands.isResizeSuppressed()) {
    return false
  }
  ctx.state.freshSubscribeGuard.add(ptyId)
  try {
    const result = await ctx.commands.enqueueLayout(ptyId, { kind: 'desktop', cols, rows })
    if (result.ok) {
      ctx.commands.refreshRendererGeometry(ptyId, cols, rows)
    }
    return result.ok
  } finally {
    ctx.state.freshSubscribeGuard.delete(ptyId)
  }
}

export function markMobileActor(ctx: TerminalLayoutContext, ptyId: string, clientId: string): void {
  const inner = ctx.state.mobileSubscribers.get(ptyId)
  const sub = inner?.get(clientId)
  if (sub) {
    sub.lastActedAt = Date.now()
  }
  ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId })
}

export function beginMobileInputFloor(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string
): { commit: () => Promise<void>; rollback: () => void } | null {
  return ctx.drivers.beginMobileInputFloor(ptyId, clientId)
}
