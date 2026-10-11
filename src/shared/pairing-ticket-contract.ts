import { z } from 'zod'

const MINUTE_MS = 60_000

// Why 10 min: matches the relay invite window; the dialog re-coalesces while it stays open.
export const PAIRING_TICKET_QR_TTL_MS = 10 * MINUTE_MS
export const PAIRING_TICKET_CLI_DEFAULT_TTL_MS = 30 * MINUTE_MS
// Why a hard cap: a headless ticket has no approval step, so it stays stealable for its whole life.
export const PAIRING_TICKET_MAX_TTL_MS = 60 * MINUTE_MS

export type PairingTicketIssuer = 'local-ui' | 'owner-cli' | 'serve-startup'
export type PairingTicketState = 'open' | 'redeeming'

export const CreatePairingTicketParamsSchema = z
  .object({
    // Why runtime only: phones redeem tickets once their device-key client ships.
    scope: z.literal('runtime').optional(),
    ttlMs: z.number().int().positive().max(PAIRING_TICKET_MAX_TTL_MS).optional()
  })
  .strict()
export type CreatePairingTicketParams = z.infer<typeof CreatePairingTicketParamsSchema>

export type CreatePairingTicketResult = {
  ticketId: string
  // The secret rides only here and in `link`'s fragment; never log either.
  code: string
  link: string
  scope: 'runtime' | 'mobile'
  issuedAt: number
  expiresAt: number
}

export type PairingTicketSummary = {
  ticketId: string
  scope: 'runtime' | 'mobile'
  issuedVia: PairingTicketIssuer
  requiresApproval: boolean
  state: PairingTicketState
  issuedAt: number
  expiresAt: number
}

export type ListPairingTicketsResult = { tickets: PairingTicketSummary[] }

export const RevokePairingTicketParamsSchema = z
  .object({ ticketId: z.string().regex(/^[0-9a-f]{6,64}$/) })
  .strict()
export type RevokePairingTicketResult = { revoked: boolean }

/** `30m`, `1h`, `90s` or bare minutes. Above the cap is an error, never a silent clamp. */
export function parsePairingTicketTtl(value: string): number {
  const match = /^(\d+)\s*(s|m|h)?$/i.exec(value.trim())
  if (!match) {
    throw new Error(`Invalid --ttl "${value}": use a duration such as 30m or 1h.`)
  }
  const unit = (match[2] ?? 'm').toLowerCase()
  const ms = Number(match[1]) * (unit === 'h' ? 60 * MINUTE_MS : unit === 'm' ? MINUTE_MS : 1000)
  if (ms <= 0) {
    throw new Error('--ttl must be longer than zero.')
  }
  if (ms > PAIRING_TICKET_MAX_TTL_MS) {
    throw new Error('--ttl cannot exceed 1h: a pairing ticket is a bearer secret until redeemed.')
  }
  return ms
}
