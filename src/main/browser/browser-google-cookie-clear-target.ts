import type { GoogleCookieClearLocalTarget } from '../../shared/browser-google-cookie-clear'
import { bindRoutePartition } from './browser-client-route-cookie-import'
import { browserSessionRegistry } from './browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from './paired-runtime-browser-client-host-runtime'
import { clearGoogleCookiesFromPartition } from './cookies/browser-google-cookie-clear'

export function googleCookieClearLocalTarget(
  profileId: string,
  environmentId: string | null
): GoogleCookieClearLocalTarget | null {
  const profile = browserSessionRegistry.getProfile(profileId)
  if (!profile) {
    return null
  }
  const identity = environmentId ? getPairedRuntimeBrowserClientRouteIdentity(environmentId) : null
  if (environmentId && !identity) {
    return null
  }
  return {
    profileId,
    environmentId,
    partition: identity ? bindRoutePartition(identity, profileId) : profile.partition,
    routeIdentity: identity ? JSON.stringify(identity) : null
  }
}

export function clearGoogleCookiesForLocalTarget(target: GoogleCookieClearLocalTarget) {
  const validate = () => {
    const current = googleCookieClearLocalTarget(target.profileId, target.environmentId)
    if (
      !current ||
      current.partition !== target.partition ||
      current.routeIdentity !== target.routeIdentity
    ) {
      throw new Error('The browser profile connection changed. Try again.')
    }
  }
  validate()
  return clearGoogleCookiesFromPartition(target.partition, validate)
}
