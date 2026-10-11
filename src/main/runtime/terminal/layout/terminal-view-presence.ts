import type { TerminalLayoutContext } from './terminal-layout-context'
import type { DriverState } from '../../orca-runtime-core'
import { addListenerToMap } from '../../orca-runtime-core'
import { notifyRuntimeListeners } from '../../runtime-async-boundaries'

export function registerRemoteTerminalViewSubscriber(
  ctx: TerminalLayoutContext,
  ptyId: string
): () => void {
  return ctx.viewSubscribers.registerRemote(ptyId)
}

export function isKnownUnattachedLocalDaemonPty(
  ctx: TerminalLayoutContext,
  ptyId: string
): boolean {
  return ctx.viewSubscribers.isKnownUnattachedLocal(ptyId)
}

export function reconcileSubscriberDrivenProviderAttach(
  ctx: TerminalLayoutContext,
  ptyId: string
): void {
  ctx.viewSubscribers.reconcileProviderAttach(ptyId)
}

export function registerRawTerminalViewSubscriber(
  ctx: TerminalLayoutContext,
  ptyId: string
): () => void {
  return ctx.viewSubscribers.registerRaw(ptyId)
}

export function hasRawTerminalViewSubscriber(ctx: TerminalLayoutContext, ptyId: string): boolean {
  return ctx.viewSubscribers.hasRaw(ptyId)
}

export function hasRemoteTerminalViewSubscriber(
  ctx: TerminalLayoutContext,
  ptyId: string
): boolean {
  return ctx.viewSubscribers.hasRemote(ptyId)
}

export function isMobileTerminalQueryReplyAuthority(
  ctx: TerminalLayoutContext,
  ptyId: string,
  clientId: string
): boolean {
  // Why: a passive phone watching desktop-sized output must not race the
  // desktop xterm. Mobile becomes reply authority only with the mobile floor.
  if (ctx.commands.getDriver(ptyId).kind !== 'mobile') {
    return false
  }
  const subscribers = ctx.state.mobileSubscribers.get(ptyId)
  if (!subscribers) {
    return false
  }
  // Why: soft-leave resubscribe preserves the original subscription time but
  // reinserts the record. Elect fitted responders from that stable age, not
  // mutable Map order or passive desktop-mode watchers.
  let earliest: { clientId: string; subscribedAt: number } | null = null
  for (const subscriber of subscribers.values()) {
    if (!subscriber.wasResizedToPhone) {
      continue
    }
    if (earliest === null || subscriber.subscribedAt < earliest.subscribedAt) {
      earliest = subscriber
    }
  }
  return earliest?.clientId === clientId
}

export function subscribeToFitOverrideChanges(
  ctx: TerminalLayoutContext,
  ptyId: string,
  listener: (event: {
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
    cols: number
    rows: number
  }) => void
): () => void {
  return addListenerToMap(ctx.state.fitOverrideListeners, ptyId, listener)
}

export function subscribeToDriverChanges(
  ctx: TerminalLayoutContext,
  ptyId: string,
  listener: (driver: DriverState) => void
): () => void {
  return ctx.drivers.subscribe(ptyId, listener)
}

export function notifyFitOverrideListeners(
  ctx: TerminalLayoutContext,
  ptyId: string,
  mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
  cols: number,
  rows: number
): void {
  const listeners = ctx.state.fitOverrideListeners.get(ptyId)
  if (!listeners) {
    return
  }
  notifyRuntimeListeners(listeners, (listener) => listener({ mode, cols, rows }), 'fit-override')
}
