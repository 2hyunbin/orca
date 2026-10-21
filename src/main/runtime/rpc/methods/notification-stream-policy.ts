import type { MobileNotificationEvent } from '../../runtime-mobile-notification-controller'

export function createNotificationStreamFilter(
  includeDesktopSuppressed = false,
  sourceEvents = false
) {
  return (event: MobileNotificationEvent): boolean => {
    if (sourceEvents) {
      return event.type === 'notification'
        ? !!event.sourcePlan && !event.sourcePlan.carrier
        : !!event.dismissedDelivery && !event.notificationId.startsWith('carry:')
    }
    if (
      event.type === 'notification'
        ? event.hostAgentAlert || event.sourcePlan?.carrier
        : event.sourceOnly
    ) {
      return false
    }
    return (
      includeDesktopSuppressed ||
      event.type !== 'notification' ||
      (event.desktopAllowed !== false && event.legacySocketAllowed !== false)
    )
  }
}
