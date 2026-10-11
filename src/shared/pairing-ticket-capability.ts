// Why dependency-free: protocol-version.ts reaches the terminal daemon's bundle (see device-key-capability.ts).
import { DEVICE_KEY_RUNTIME_CAPABILITIES } from './device-key-capability'

// Why: an older host refuses the redemption shape with bad_auth; clients send it only when this is advertised.
export const PAIRING_TICKET_RUNTIME_CAPABILITY = 'pairing.ticket.v1' as const

export const CREATE_PAIRING_TICKET_METHOD = 'pairing.createTicket' as const
export const LIST_PAIRING_TICKETS_METHOD = 'pairing.listTickets' as const
export const REVOKE_PAIRING_TICKET_METHOD = 'pairing.revokeTicket' as const

export const PAIRING_CREDENTIAL_RUNTIME_CAPABILITIES = [
  ...DEVICE_KEY_RUNTIME_CAPABILITIES,
  PAIRING_TICKET_RUNTIME_CAPABILITY
] as const
