import type { TerminalLayoutContext } from './terminal-layout-context'

import { clampTerminalViewport } from '../../terminal-viewport'

export async function handleMobileSubscribe(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  viewport?: { cols: number; rows: number }
): Promise<boolean> {
  try {
    return await ctx.commands.handleMobileSubscribeInternal(ptyId, clientId, viewport)
  } finally {
    // Every subscribe path mutates mobileSubscribers — resync the daemon
    // background mark once, whatever branch returned.
    ctx.commands.notifyRemoteTerminalViewPresenceChanged(ptyId)
  }
}

export async function handleMobileSubscribeInternal(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string,
  viewport?: { cols: number; rows: number }
): Promise<boolean> {
  const mode = ctx.commands.getMobileDisplayMode(ptyId)

  // Cancel pending restore timer for this ptyId — any new subscriber
  // supersedes any old client's pending restore.
  const pendingRestore = ctx.state.pendingRestoreTimers.get(ptyId)
  if (pendingRestore) {
    clearTimeout(pendingRestore.timer)
    ctx.state.pendingRestoreTimers.delete(ptyId)
  }

  // Resubscribe-grace honor: same client returning within soft-leave
  // window restores prior record (preserving baseline so we don't capture
  // phone-fitted dims as the new baseline).
  const softLeaver = ctx.state.pendingSoftLeavers.get(ptyId)
  if (softLeaver && softLeaver.clientId === clientId) {
    clearTimeout(softLeaver.timer)
    ctx.state.pendingSoftLeavers.delete(ptyId)
    let inner = ctx.state.mobileSubscribers.get(ptyId)
    if (!inner) {
      inner = new Map()
      ctx.state.mobileSubscribers.set(ptyId, inner)
    }
    inner.set(clientId, {
      ...softLeaver.record,
      viewport: viewport ?? null,
      lastActedAt: Date.now()
    })
    if (!viewport) {
      return false
    }
    ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId })
    if (mode !== 'desktop') {
      const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
        viewport.cols,
        viewport.rows
      )
      ctx.state.freshSubscribeGuard.add(ptyId)
      try {
        await ctx.commands.enqueueLayout(ptyId, {
          kind: 'phone',
          cols: clampedCols,
          rows: clampedRows,
          ownerClientId: clientId
        })
      } finally {
        ctx.state.freshSubscribeGuard.delete(ptyId)
      }
    }
    return true
  }

  let inner = ctx.state.mobileSubscribers.get(ptyId)
  if (!inner) {
    inner = new Map()
    ctx.state.mobileSubscribers.set(ptyId, inner)
  }

  // Capture restore baseline BEFORE applyLayout writes the override.
  // Multi-mobile: peer joiner against an already-fitted PTY captures null
  // — the existing baseline-holder's snapshot remains canonical. See
  // docs/mobile-presence-lock.md.
  //
  // Resubscribe-after-indefinite-hold: the held override carries the only
  // authoritative pre-fit dims across the no-subscriber gap. Inherit it
  // first; otherwise rendererSize/currentSize would be the held phone dims
  // and applyLayout would clobber the override's previousCols with phone
  // dims, making any subsequent Restore a no-op.
  const heldOverride = ctx.state.terminalFitOverrides.get(ptyId)
  const existing = inner.get(clientId)
  const someoneAlreadyFitted = [...inner.values()].some((s) => s.wasResizedToPhone)
  const currentSize = ctx.host.getTerminalSize(ptyId)
  const rendererSize = ctx.state.lastRendererSizes.get(ptyId)
  const previousCols =
    existing?.previousCols ??
    heldOverride?.previousCols ??
    (someoneAlreadyFitted ? null : (rendererSize?.cols ?? currentSize?.cols ?? null))
  const previousRows =
    existing?.previousRows ??
    heldOverride?.previousRows ??
    (someoneAlreadyFitted ? null : (rendererSize?.rows ?? currentSize?.rows ?? null))
  const now = Date.now()
  const subscribedAt = existing?.subscribedAt ?? now

  if (!viewport) {
    // Why: mobile can subscribe before its WebView has measured. Keep the
    // subscriber + desktop baseline so updateViewport/setDisplayMode can
    // late-bind the viewport without recapturing phone dims.
    inner.set(clientId, {
      clientId,
      viewport: null,
      wasResizedToPhone: false,
      previousCols,
      previousRows,
      subscribedAt,
      lastActedAt: now
    })
    return false
  }

  const { cols: clampedCols, rows: clampedRows } = clampTerminalViewport(
    viewport.cols,
    viewport.rows
  )

  if (mode === 'desktop') {
    // Passive watch — null baseline (we'll capture later if user toggles
    // to auto/phone, since safeFit will have converged by then). Do not
    // flip driver.
    inner.set(clientId, {
      clientId,
      viewport,
      wasResizedToPhone: false,
      previousCols: null,
      previousRows: null,
      subscribedAt,
      lastActedAt: now
    })
    return false
  }

  inner.set(clientId, {
    clientId,
    viewport,
    wasResizedToPhone: true,
    previousCols,
    previousRows,
    subscribedAt,
    lastActedAt: now
  })

  // Subscribe-fresh with auto/phone counts as "take the floor".
  ctx.commands.setDriver(ptyId, { kind: 'mobile', clientId })

  // Route the actual resize through the state machine. The fresh-subscribe
  // gate lets enqueueLayout's "no layouts entry" short-circuit pass on
  // the very first transition for this PTY.
  ctx.state.freshSubscribeGuard.add(ptyId)
  try {
    await ctx.commands.enqueueLayout(ptyId, {
      kind: 'phone',
      cols: clampedCols,
      rows: clampedRows,
      ownerClientId: clientId
    })
  } finally {
    ctx.state.freshSubscribeGuard.delete(ptyId)
  }

  return true
}
