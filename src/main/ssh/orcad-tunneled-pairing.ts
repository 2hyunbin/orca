import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { ServeReadiness } from '../server/serve-readiness'

export function tunneledOrcadPairingCode(
  readiness: ServeReadiness,
  localPort: number,
  pairedOffer?: PairingOffer | null
): string {
  if (!pairedOffer && !readiness.pairing.available) {
    throw new Error(
      `This host’s Orca server did not publish a pairing offer: ${readiness.pairing.guidance}`
    )
  }
  // An enrolled client keeps its grant; startup offers are for new clients.
  const offer =
    pairedOffer ?? (readiness.pairing.available ? parsePairingCode(readiness.pairing.url) : null)
  if (!offer) {
    throw new Error('This host’s Orca server published an invalid pairing offer.')
  }
  const endpoint = new URL(offer.endpoint)
  if (
    (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
    classifyRemotePairingHostname(endpoint.hostname) !== 'loopback'
  ) {
    throw new Error('The pairing endpoint of this host’s Orca server is not loopback-only.')
  }
  endpoint.hostname = '127.0.0.1'
  endpoint.port = String(localPort)
  return encodePairingOffer({ ...offer, endpoint: endpoint.toString() })
}

/**
 * Why a restarted server's own offer is still read: it names the host key now, and a key other
 * than the pinned one means every later connect is refused, which only re-adding the server fixes.
 */
export function orcadHostKeyChangeWarning(
  readiness: ServeReadiness,
  pinned: PairingOffer
): string | null {
  const published = readiness.pairing.available
    ? parsePairingCode(readiness.pairing.url)?.publicKeyB64
    : undefined
  return published && published !== pinned.publicKeyB64
    ? 'This server now publishes a host key other than the one this desktop trusts, so Orca will refuse to connect to it. If you expected the change, remove the server and add it again.'
    : null
}
