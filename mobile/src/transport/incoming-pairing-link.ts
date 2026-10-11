import { extractVerifiedPairingLinkCode } from '../../../src/shared/verified-pairing-link'

export const PAIR_SCAN_LINK_REFUSED_NOTICE = 'custom-scheme-link'

const REFUSED_PATH = `/pair-scan?notice=${PAIR_SCAN_LINK_REFUSED_NOTICE}`
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
  const match = /^(?:([a-z][a-z0-9+.-]*):(?:\/\/)?)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url.trim())
  if (!match) {
    return null
  }
  const [, scheme, location = '', query = '', fragment = ''] = match
  // Why: `code` is the confirm screen's input, so no unverified link may carry one at any depth. The
  // router unwraps nested links (e.g. `expo-development-client/?url=`) after this hook runs.
  if (/[?&#]code=/i.test(fullyDecode(url))) {
    return REFUSED_PATH
  }
  // Why: the router ignores an https link's host, and reads a custom scheme's host as the route.
  const path = /^https?$/i.test(scheme ?? '') ? location.replace(/^[^/]*/, '') : location
  const segments = safeDecode(path)
    .toLowerCase()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (!segments.some((segment) => PAIRING_ROUTES.has(segment))) {
    return null
  }
  return query.length > 1 || fragment.length > 1 ? REFUSED_PATH : '/pair-scan'
}

function fullyDecode(value: string): string {
  let decoded = value
  for (let pass = 0; pass < 5; pass++) {
    // Why per run: one malformed escape elsewhere must not leave an encoded `code=` undecoded.
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, safeDecode)
    if (next === decoded) {
      break
    }
    decoded = next
  }
  return decoded
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
