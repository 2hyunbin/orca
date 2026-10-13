import { Notification } from 'electron'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'

// Why identifiers: close() needs the live Notification object, which main releases after five
// minutes and loses on restart; Notification Center removes by identifier with no object at all.

function paneGroupId(paneKey: string): string {
  return `pane:${paneKey}`
}

/** The macOS identifier and thread for a notification; empty elsewhere. */
export function macosNotificationIdentity(request: NotificationDispatchRequest): {
  id?: string
  groupId?: string
} {
  // Why darwin only: Windows maps these to toast Tag/Group (length-capped, with its own replace
  // rules) and Electron can only remove by identifier on macOS.
  if (process.platform !== 'darwin' || !request.paneKey) {
    return {}
  }
  // Why structured alerts get an id and no thread: only a read that covers their journal position
  // retires them, so they are removed one by one. Their id is announced once, so it never repeats.
  if (request.structuredOrigin) {
    return request.notificationId ? { id: request.notificationId } : {}
  }
  // Why no id here: Electron routes a click to the first object it ever showed with that id, so a
  // reused id (a repeat bell, a re-sent turn) after release sends clicks to a dead handler.
  return { groupId: paneGroupId(request.paneKey) }
}

function tryRemove(remove: () => void): void {
  try {
    remove()
  } catch (error) {
    // Why caught: removal is cleanup; a Notification Center failure must not fail the dismissal.
    console.warn('[notifications] Could not remove delivered notifications', error)
  }
}

/** Removes delivered notifications for these ids and every notification in these panes' threads. */
export function removeDeliveredMacosNotifications(
  ids: ReadonlySet<string>,
  paneKeys: readonly string[]
): void {
  if (process.platform !== 'darwin') {
    return
  }
  if (ids.size > 0) {
    tryRemove(() => Notification.remove([...ids]))
  }
  for (const paneKey of paneKeys) {
    tryRemove(() => Notification.removeGroup(paneGroupId(paneKey)))
  }
}
