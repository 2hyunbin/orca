import {
  PAIRING_TICKET_CLI_DEFAULT_TTL_MS,
  type CreatePairingTicketParams,
  type CreatePairingTicketResult
} from '../../../shared/pairing-ticket-contract'
import { encodePairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import type { RuntimeHostDescriptor } from '../../../shared/runtime-host-descriptor'
import type { PairingTicketBook } from '../pairing-ticket-book'
import type { PairingTicketOwnerContext } from '../pairing-ticket-owner-context'
import type { PairingOfferUnavailable } from './runtime-rpc-pairing-types'

export type PairingTicketHost =
  | {
      available: true
      endpoint: string
      publicKeyB64: string
      hostDescriptor: RuntimeHostDescriptor | null
    }
  | PairingOfferUnavailable

/** Headless `orca pairing` commands: owner-minted bearer tickets with no approval step (Decision 3). */
export function createOwnerPairingTicketContext(args: {
  tickets: PairingTicketBook
  resolveHost: () => PairingTicketHost
}): PairingTicketOwnerContext {
  return {
    create: (params: CreatePairingTicketParams): CreatePairingTicketResult => {
      const host = args.resolveHost()
      if (!host.available) {
        throw new Error(host.guidance)
      }
      const minted = args.tickets.mint({
        issuedVia: 'owner-cli',
        scope: params.scope ?? 'runtime',
        grants: [],
        reach: 'network',
        ttlMs: params.ttlMs ?? PAIRING_TICKET_CLI_DEFAULT_TTL_MS
      })
      const { code, link } = encodePairingTicketOffer({
        v: 3,
        endpoint: host.endpoint,
        publicKeyB64: host.publicKeyB64,
        ticket: minted.ticket,
        deviceId: minted.deviceId,
        scope: minted.scope,
        expiresAt: minted.expiresAt,
        ...(host.hostDescriptor ? { hostDescriptor: host.hostDescriptor } : {})
      })
      return {
        ticketId: minted.ticketId,
        code,
        link,
        scope: minted.scope,
        issuedAt: minted.issuedAt,
        expiresAt: minted.expiresAt
      }
    },
    list: () => ({ tickets: args.tickets.list() }),
    revoke: (ticketId) => ({ revoked: args.tickets.revoke(ticketId) })
  }
}
