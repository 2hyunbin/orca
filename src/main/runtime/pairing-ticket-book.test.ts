import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PAIRING_TICKET_CLI_DEFAULT_TTL_MS,
  PAIRING_TICKET_MAX_TTL_MS,
  PAIRING_TICKET_QR_TTL_MS
} from '../../shared/pairing-ticket-contract'
import { PairingTicketBook, PairingTicketTtlError } from './pairing-ticket-book'

const MINUTE = 60_000

function book(start = 1_000_000) {
  const clock = { now: start }
  return { clock, tickets: new PairingTicketBook({ now: () => clock.now }) }
}

const cli = {
  issuedVia: 'owner-cli',
  scope: 'runtime',
  grants: [],
  reach: 'network',
  ttlMs: PAIRING_TICKET_CLI_DEFAULT_TTL_MS
} as const
const ui = { ...cli, issuedVia: 'local-ui', ttlMs: PAIRING_TICKET_QR_TTL_MS } as const

describe('PairingTicketBook', () => {
  it('mints an opaque 256-bit ticket and keeps only its hash', () => {
    const { tickets } = book()
    const minted = tickets.mint(cli)
    expect(Buffer.from(minted.ticket, 'base64url')).toHaveLength(32)
    expect(minted.ticketId).toBe(
      createHash('sha256').update(minted.ticket).digest('hex').slice(0, 12)
    )
    expect(JSON.stringify(tickets.list())).not.toContain(minted.ticket)
    expect(JSON.stringify([...tickets['entries'].values()])).not.toContain(minted.ticket)
  })

  it('rejects a TTL above the one-hour cap instead of clamping it', () => {
    const { tickets } = book()
    expect(() => tickets.mint({ ...cli, ttlMs: PAIRING_TICKET_MAX_TTL_MS + 1 })).toThrow(
      PairingTicketTtlError
    )
    expect(() => tickets.mint({ ...cli, ttlMs: 0 })).toThrow(PairingTicketTtlError)
    expect(tickets.mint({ ...cli, ttlMs: PAIRING_TICKET_MAX_TTL_MS }).expiresAt).toBe(
      1_000_000 + PAIRING_TICKET_MAX_TTL_MS
    )
  })

  it('coalesces repeated local-UI mints until a minute before expiry, then renews', () => {
    const { clock, tickets } = book()
    const first = tickets.mint(ui)
    clock.now += 5 * MINUTE
    expect(tickets.mint(ui).ticket).toBe(first.ticket)
    clock.now += 4.5 * MINUTE
    const renewed = tickets.mint(ui)
    expect(renewed.ticket).not.toBe(first.ticket)
    // Why: a renewal retires its predecessor, so only one QR code is ever live.
    expect(tickets.beginRedemption(first.ticket).kind).toBe('invalid')
    expect(tickets.beginRedemption(renewed.ticket).kind).toBe('locked')
  })

  it('never coalesces owner-CLI tickets and keeps their plaintext out of memory', () => {
    const { tickets } = book()
    const first = tickets.mint(cli)
    const second = tickets.mint(cli)
    expect(second.ticket).not.toBe(first.ticket)
    for (const entry of tickets['entries'].values()) {
      expect(entry.coalescePlaintext).toBeUndefined()
    }
  })

  it('locks on redemption, so a concurrent redemption sees the ticket as consumed', () => {
    const { tickets } = book()
    const minted = tickets.mint(cli)
    const first = tickets.beginRedemption(minted.ticket)
    expect(first.kind).toBe('locked')
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('consumed')
    expect(tickets.list()[0]?.state).toBe('redeeming')
  })

  it('tombstones a committed ticket until its own expiry', () => {
    const { clock, tickets } = book()
    const minted = tickets.mint(cli)
    const lease = tickets.beginRedemption(minted.ticket)
    if (lease.kind !== 'locked') {
      throw new Error('expected a lock')
    }
    expect(lease.ticket.reservedDeviceId).toBe(minted.deviceId)
    lease.commit()
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('consumed')
    expect(tickets.list()).toEqual([])
    clock.now = minted.expiresAt
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
    expect(tickets['entries'].size).toBe(0)
  })

  it('burns a denied ticket and releases one whose commit could not be written', () => {
    const { tickets } = book()
    const denied = tickets.mint(cli)
    const deniedLease = tickets.beginRedemption(denied.ticket)
    if (deniedLease.kind !== 'locked') {
      throw new Error('expected a lock')
    }
    deniedLease.burn()
    expect(tickets.beginRedemption(denied.ticket).kind).toBe('invalid')

    const retried = tickets.mint(cli)
    const lease = tickets.beginRedemption(retried.ticket)
    if (lease.kind !== 'locked') {
      throw new Error('expected a lock')
    }
    lease.release()
    expect(tickets.beginRedemption(retried.ticket).kind).toBe('locked')
  })

  it('burns a ticket after repeated bad proofs', () => {
    const { tickets } = book()
    const minted = tickets.mint(cli)
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(tickets.recordFailedProof(minted.ticket)).toBe(false)
    }
    expect(tickets.recordFailedProof(minted.ticket)).toBe(true)
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
  })

  it('expires unredeemed tickets on the host clock', () => {
    const { clock, tickets } = book()
    const minted = tickets.mint(cli)
    clock.now = minted.expiresAt - 1
    expect(tickets.list()).toHaveLength(1)
    clock.now = minted.expiresAt
    expect(tickets.list()).toEqual([])
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
  })

  it('keeps a locked ticket past expiry so a pending approval can still commit', () => {
    const { clock, tickets } = book()
    const minted = tickets.mint(ui)
    const lease = tickets.beginRedemption(minted.ticket)
    clock.now = minted.expiresAt + MINUTE
    if (lease.kind !== 'locked') {
      throw new Error('expected a lock')
    }
    expect(tickets.list()[0]?.state).toBe('redeeming')
    lease.commit()
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
  })

  it('revokes an outstanding ticket by its listed id', () => {
    const { tickets } = book()
    const minted = tickets.mint(cli)
    expect(tickets.revoke('nope')).toBe(false)
    expect(tickets.revoke(minted.ticketId)).toBe(true)
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
    expect(tickets.list()).toEqual([])
  })

  it('records who minted a ticket and whether the owner must approve it', () => {
    const { tickets } = book()
    tickets.mint(cli)
    tickets.mint(ui)
    expect(tickets.list().map((entry) => [entry.issuedVia, entry.requiresApproval])).toEqual([
      ['owner-cli', false],
      ['local-ui', true]
    ])
  })

  it('remembers reserved device ids until the ticket expires', () => {
    const { clock, tickets } = book()
    const minted = tickets.mint(cli)
    expect(tickets.isReservedDeviceId(minted.deviceId)).toBe(true)
    expect(tickets.isReservedDeviceId('other')).toBe(false)
    clock.now = minted.expiresAt
    expect(tickets.isReservedDeviceId(minted.deviceId)).toBe(false)
  })
})
