import type { TerminalLayoutContext, TerminalFitOverride } from './terminal-layout-context'
import type { ApplyLayoutResult, DriverState } from '../../orca-runtime-core'

import { clampTerminalViewport } from '../../terminal-viewport'

export async function resizeForClient(
  ctx: TerminalLayoutContext,
  ptyId: string,
  mode: 'mobile-fit' | 'restore',
  clientId: string,
  cols?: number,
  rows?: number
): Promise<{
  cols: number
  rows: number
  previousCols: number | null
  previousRows: number | null
  mode: 'mobile-fit' | 'desktop-fit'
}> {
  if (mode === 'mobile-fit') {
    if (cols == null || rows == null || !Number.isFinite(cols) || !Number.isFinite(rows)) {
      throw new Error('invalid_dimensions')
    }
    const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(cols, rows)

    const currentSize = ctx.host.getTerminalSize(ptyId)
    const existing = ctx.state.terminalFitOverrides.get(ptyId)
    // Capture baseline cols/rows for the return value (existing override's
    // baseline wins over current size to preserve original desktop dims
    // across multiple re-fits).
    const previousCols = existing?.previousCols ?? currentSize?.cols ?? null
    const previousRows = existing?.previousRows ?? currentSize?.rows ?? null

    // Why: legacy resizeForClient callers bypass handleMobileSubscribe, so
    // mobileSubscribers stays empty and resolveDesktopRestoreTarget's step-1
    // (per-subscriber baseline) never matches. Stash the pre-fit PTY size
    // into lastRendererSizes so restore lands on step 2 (renderer geometry)
    // instead of step 3 (current phone-fit dims = no-op restore).
    if (currentSize && !existing) {
      ctx.state.lastRendererSizes.set(ptyId, {
        cols: currentSize.cols,
        rows: currentSize.rows
      })
    }

    ctx.state.freshSubscribeGuard.add(ptyId)
    let result: ApplyLayoutResult
    try {
      result = await ctx.commands.enqueueLayout(ptyId, {
        kind: 'phone',
        cols: clampedCols,
        rows: clampedRows,
        ownerClientId: clientId
      })
    } finally {
      ctx.state.freshSubscribeGuard.delete(ptyId)
    }
    if (!result.ok) {
      throw new Error('resize_failed')
    }

    // Why: mobile-fit via resizeForClient is a deliberate mobile action;
    // the actor takes the floor (updates lastActedAt; mode-flip case is
    // already handled by enqueueLayout above).
    await ctx.commands.mobileTookFloor(ptyId, clientId)

    return {
      cols: clampedCols,
      rows: clampedRows,
      previousCols,
      previousRows,
      mode: 'mobile-fit'
    }
  }

  // restore mode
  const override = ctx.state.terminalFitOverrides.get(ptyId)
  if (!override) {
    throw new Error('no_active_override')
  }
  // Only the owning client can restore — prevents one phone from undoing
  // another phone's active fit.
  if (override.clientId !== clientId) {
    throw new Error('not_override_owner')
  }

  const restore = ctx.commands.resolveDesktopRestoreTarget(ptyId)
  const result = await ctx.commands.enqueueLayout(ptyId, {
    kind: 'desktop',
    cols: restore.cols,
    rows: restore.rows
  })
  if (!result.ok) {
    throw new Error('resize_failed')
  }

  // Why: legacy mobile clients on the resizeForClient path also need a
  // fit-override-listener notification (the renderer-side terminalFitOverrideChanged
  // is already emitted by applyLayout's mode-flip path).
  ctx.commands.notifyFitOverrideListeners(ptyId, 'desktop-fit', restore.cols, restore.rows)

  return {
    cols: restore.cols,
    rows: restore.rows,
    previousCols: null,
    previousRows: null,
    mode: 'desktop-fit'
  }
}

export function getTerminalFitOverride(
  ctx: TerminalLayoutContext,
  ptyId: string
): TerminalFitOverride | null {
  return ctx.state.terminalFitOverrides.get(ptyId) ?? null
}

export function getAllTerminalFitOverrides(
  ctx: TerminalLayoutContext
): Map<string, { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }> {
  const result = new Map<
    string,
    { mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }
  >()
  for (const [ptyId, override] of ctx.state.terminalFitOverrides) {
    result.set(ptyId, { mode: override.mode, cols: override.cols, rows: override.rows })
  }
  for (const ptyId of ctx.remoteDesktopFloor.ownerPtyIds()) {
    if (result.has(ptyId)) {
      continue
    }
    const size = ctx.host.getTerminalSize(ptyId)
    if (size) {
      result.set(ptyId, { mode: 'remote-desktop-fit', ...size })
    }
  }
  return result
}

export function getAllTerminalDrivers(ctx: TerminalLayoutContext): Map<string, DriverState> {
  return ctx.drivers.getAll()
}
