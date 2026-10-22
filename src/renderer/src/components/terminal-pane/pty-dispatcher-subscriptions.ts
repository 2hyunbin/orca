import { attachPtyPushListeners, eagerPtyHandles, ptyDataHandlers } from './pty-dispatcher'
import { exposeE2eTerminalPtyAckGate } from './terminal-pty-ack-gate'
import {
  startTerminalDeliveryWatchdog,
  stopTerminalDeliveryWatchdog
} from './terminal-delivery-watchdog'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import { installTerminalFreezeReport } from './terminal-freeze-report'

let ptyDispatcherAttached = false

export let pushListenerUnsubscribes: (() => void)[] = []

/** Detach and re-subscribe every push-channel listener; called by the delivery watchdog on a confirmed wedge. */
export function reattachPtyDispatcherPushListeners(): void {
  recordTerminalFreezeBreadcrumb('push-listeners-reattach', {
    staleListenerCount: pushListenerUnsubscribes.length
  })
  const stale = pushListenerUnsubscribes
  pushListenerUnsubscribes = []
  for (const unsubscribe of stale) {
    unsubscribe()
  }
  attachPtyPushListeners()
}

export function ensurePtyDispatcher(): void {
  if (ptyDispatcherAttached) {
    return
  }
  ptyDispatcherAttached = true
  try {
    exposeE2eTerminalPtyAckGate()
    installTerminalFreezeReport()
    attachPtyPushListeners()
    startTerminalDeliveryWatchdog({
      reattachPushListeners: reattachPtyDispatcherPushListeners,
      hasAttachedPtys: () => ptyDataHandlers.size > 0 || eagerPtyHandles.size > 0
    })
  } catch (error) {
    ptyDispatcherAttached = false
    stopTerminalDeliveryWatchdog()
    for (const unsubscribe of pushListenerUnsubscribes.splice(0)) {
      try {
        unsubscribe()
      } catch (cleanupError) {
        console.warn('[pty] could not detach partial dispatcher', cleanupError)
      }
    }
    throw error
  }
}
