import { extractVerifiedPairingLinkCode } from '../../../src/shared/verified-pairing-link'

export const PAIR_SCAN_LINK_REFUSED_NOTICE = 'custom-scheme-link'

const PAIRING_ROUTES = new Set(['pair', 'pair-confirm'])

/**
 * Rewrites an OS-delivered link before the router sees it. Null leaves the link to the router.
 * Why: the OS hands an `orca://` URL to whichever app claimed the scheme, so a code it carries may
 * already be in another app's hands. Only a verified https link may start pairing.
 */
export function redirectIncomingPairingLink(url: string): string | null {
  const verifiedCode = extractVerifiedPairingLinkCode(url)
  if (verifiedCode) {
    return `/pair-confirm?code=${encodeURIComponent(verifiedCode)}`
  }
  const parsed = parseRoute(url.trim())
  if (!parsed || !PAIRING_ROUTES.has(parsed.route)) {
    return null
  }
  return parsed.carriesPayload ? `/pair-scan?notice=${PAIR_SCAN_LINK_REFUSED_NOTICE}` : '/pair-scan'
}

function parseRoute(url: string): { route: string; carriesPayload: boolean } | null {
  const match = /^(?:([a-z][a-z0-9+.-]*):(?:\/\/)?)?([^?#]*)(.*)$/i.exec(url)
  if (!match) {
    return null
  }
  const [, scheme, location = '', rest = ''] = match
  // Why: the router ignores an https link's host, and reads a custom scheme's host as the route.
  const path = /^https?$/i.test(scheme ?? '') ? location.replace(/^[^/]*/, '') : location
  return {
    route: path.replace(/^\/+|\/+$/g, '').toLowerCase(),
    carriesPayload: /[^?#]/.test(rest)
  }
}
