import { defineMethod } from '../core'
import {
  CREATE_PAIRING_TICKET_METHOD,
  LIST_PAIRING_TICKETS_METHOD,
  REVOKE_PAIRING_TICKET_METHOD
} from '../../../../shared/pairing-ticket-capability'
import {
  CreatePairingTicketParamsSchema,
  RevokePairingTicketParamsSchema
} from '../../../../shared/pairing-ticket-contract'

// Why pairing-admin plus an owner-only context: paired runtimes are never granted pairing-admin, these
// names are off the phone allowlist, and only the owner's local transport sets ctx.pairingTickets.
export const PAIRING_TICKET_METHODS = [
  defineMethod({
    name: CREATE_PAIRING_TICKET_METHOD,
    permission: 'pairing-admin',
    params: CreatePairingTicketParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.pairingTickets) {
        throw new Error('pairing_tickets_owner_only')
      }
      return ctx.pairingTickets.create(params)
    }
  }),
  defineMethod({
    name: LIST_PAIRING_TICKETS_METHOD,
    permission: 'pairing-admin',
    params: null,
    handler: (_params, ctx) => {
      if (!ctx.pairingTickets) {
        throw new Error('pairing_tickets_owner_only')
      }
      return ctx.pairingTickets.list()
    }
  }),
  defineMethod({
    name: REVOKE_PAIRING_TICKET_METHOD,
    permission: 'pairing-admin',
    params: RevokePairingTicketParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.pairingTickets) {
        throw new Error('pairing_tickets_owner_only')
      }
      return ctx.pairingTickets.revoke(params.ticketId)
    }
  })
]
