import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  PAIRING_TICKET_MAX_TTL_MS,
  type PairingTicketIssuer,
  type PairingTicketSummary
} from '../../shared/pairing-ticket-contract'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

const TICKET_BYTES = 32
const TICKET_ID_HEX = 12
const COALESCE_MIN_REMAINING_MS = 60_000
const MAX_FAILED_PROOFS = 5

type TicketScope = 'runtime' | 'mobile'

export type PairingTicketMint = {
  issuedVia: PairingTicketIssuer
  scope: TicketScope
  grants: readonly RuntimeDeviceGrant[]
  reach: RuntimePairingReach
  ttlMs: number
}

export type MintedPairingTicket = {
  ticket: string
  ticketId: string
  deviceId: string
  scope: TicketScope
  issuedAt: number
  expiresAt: number
}

/** What a redemption is allowed to become; fixed at mint (I6). */
export type RedeemablePairingTicket = Omit<PairingTicketMint, 'ttlMs'> & {
  ticketId: string
  reservedDeviceId: string
  requiresApproval: boolean
}

type TicketEntry = RedeemablePairingTicket & {
  hash: string
  issuedAt: number
  expiresAt: number
  state: 'open' | 'redeeming' | 'consumed' | 'burned'
  failedProofs: number
  // Why: only coalesced tickets keep plaintext, so a re-shown dialog can display the same code.
  coalescePlaintext?: string
  coalesceKey?: string
}

export type PairingTicketLease = {
  kind: 'locked'
  ticket: RedeemablePairingTicket
  /** The device row is durably written: the ticket can never be redeemed again. */
  commit: () => void
  /** Denied or timed out: the ticket is spent. */
  burn: () => void
  /** Nothing was written (e.g. the registry write failed): the client may retry. */
  release: () => void
}

export type PairingTicketRedemption =
  | PairingTicketLease
  | { kind: 'consumed' }
  | { kind: 'invalid' }

export class PairingTicketTtlError extends Error {
  constructor() {
    super(`Pairing ticket lifetime must be between 1 ms and ${PAIRING_TICKET_MAX_TTL_MS} ms.`)
  }
}

export function hashPairingTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex')
}

/**
 * Single-use pairing tickets, in memory only: a restart drops every unredeemed ticket and the UI
 * mints again. Only sha256(ticket) is kept (I1); expiry follows the host clock (I2).
 */
export class PairingTicketBook {
  private readonly entries = new Map<string, TicketEntry>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  mint(request: PairingTicketMint): MintedPairingTicket {
    if (!(request.ttlMs > 0 && request.ttlMs <= PAIRING_TICKET_MAX_TTL_MS)) {
      throw new PairingTicketTtlError()
    }
    const now = this.sweep()
    const coalesceKey = request.issuedVia === 'owner-cli' ? undefined : coalesceKeyOf(request)
    if (coalesceKey) {
      for (const entry of this.entries.values()) {
        if (entry.coalesceKey !== coalesceKey || entry.state !== 'open') {
          continue
        }
        if (entry.expiresAt - now > COALESCE_MIN_REMAINING_MS && entry.coalescePlaintext) {
          return mintedFrom(entry, entry.coalescePlaintext)
        }
        // Why: a renewal retires its predecessor, so only one coalesced code is ever live.
        entry.state = 'burned'
        entry.coalescePlaintext = undefined
      }
    }
    const ticket = randomBytes(TICKET_BYTES).toString('base64url')
    const hash = hashPairingTicket(ticket)
    const entry: TicketEntry = {
      issuedVia: request.issuedVia,
      scope: request.scope,
      grants: [...request.grants],
      reach: request.reach,
      ticketId: hash.slice(0, TICKET_ID_HEX),
      reservedDeviceId: randomUUID(),
      requiresApproval: request.issuedVia === 'local-ui',
      hash,
      issuedAt: now,
      expiresAt: now + request.ttlMs,
      state: 'open',
      failedProofs: 0,
      ...(coalesceKey ? { coalesceKey, coalescePlaintext: ticket } : {})
    }
    this.entries.set(hash, entry)
    return mintedFrom(entry, ticket)
  }

  list(): PairingTicketSummary[] {
    this.sweep()
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'open' || entry.state === 'redeeming')
      .map((entry) => ({
        ticketId: entry.ticketId,
        scope: entry.scope,
        issuedVia: entry.issuedVia,
        requiresApproval: entry.requiresApproval,
        state: entry.state === 'redeeming' ? 'redeeming' : 'open',
        issuedAt: entry.issuedAt,
        expiresAt: entry.expiresAt
      }))
  }

  revoke(ticketId: string): boolean {
    this.sweep()
    for (const entry of this.entries.values()) {
      if (entry.ticketId === ticketId && entry.state === 'open') {
        entry.state = 'burned'
        entry.coalescePlaintext = undefined
        return true
      }
    }
    return false
  }

  /** Synchronous lookup-and-lock (I1): a concurrent redemption sees the ticket as consumed. */
  beginRedemption(ticket: string): PairingTicketRedemption {
    this.sweep()
    const entry = this.entries.get(hashPairingTicket(ticket))
    if (!entry || entry.state === 'burned') {
      return { kind: 'invalid' }
    }
    if (entry.state !== 'open') {
      return { kind: 'consumed' }
    }
    entry.state = 'redeeming'
    const settle = (state: TicketEntry['state']): void => {
      if (entry.state === 'redeeming') {
        entry.state = state
        if (state !== 'open') {
          entry.coalescePlaintext = undefined
        }
      }
    }
    return {
      kind: 'locked',
      ticket: toRedeemable(entry),
      commit: () => settle('consumed'),
      burn: () => settle('burned'),
      release: () => settle('open')
    }
  }

  /** Counts a bad proof against an open ticket; true once the ticket is burned for it. */
  recordFailedProof(ticket: string): boolean {
    const entry = this.entries.get(hashPairingTicket(ticket))
    if (!entry || entry.state !== 'open') {
      return false
    }
    entry.failedProofs += 1
    if (entry.failedProofs < MAX_FAILED_PROOFS) {
      return false
    }
    entry.state = 'burned'
    entry.coalescePlaintext = undefined
    return true
  }

  private sweep(): number {
    const now = this.now()
    for (const [hash, entry] of this.entries) {
      // Why: a redemption awaiting the owner's answer may outlive the ticket; it settles itself.
      if (entry.expiresAt <= now && entry.state !== 'redeeming') {
        this.entries.delete(hash)
      }
    }
    return now
  }
}

function coalesceKeyOf(request: PairingTicketMint): string {
  return [
    request.issuedVia,
    request.scope,
    request.reach,
    [...request.grants].sort().join(',')
  ].join('|')
}

function toRedeemable(entry: TicketEntry): RedeemablePairingTicket {
  return {
    issuedVia: entry.issuedVia,
    scope: entry.scope,
    grants: entry.grants,
    reach: entry.reach,
    ticketId: entry.ticketId,
    reservedDeviceId: entry.reservedDeviceId,
    requiresApproval: entry.requiresApproval
  }
}

function mintedFrom(entry: TicketEntry, ticket: string): MintedPairingTicket {
  return {
    ticket,
    ticketId: entry.ticketId,
    deviceId: entry.reservedDeviceId,
    scope: entry.scope,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt
  }
}
