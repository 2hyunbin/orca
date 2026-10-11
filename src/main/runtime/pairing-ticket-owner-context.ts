import type {
  CreatePairingTicketParams,
  CreatePairingTicketResult,
  ListPairingTicketsResult,
  RevokePairingTicketResult
} from '../../shared/pairing-ticket-contract'

// Why a context: only the owner transport sets it, so no paired caller can mint a credential (I6).
export type PairingTicketOwnerContext = {
  create: (params: CreatePairingTicketParams) => CreatePairingTicketResult
  list: () => ListPairingTicketsResult
  revoke: (ticketId: string) => RevokePairingTicketResult
}
