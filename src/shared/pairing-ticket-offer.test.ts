import { describe, expect, it } from 'vitest'
import { parsePairingCode } from './pairing'
import { decodePairingTicketCode, encodePairingTicketOffer } from './pairing-ticket-offer'

const offer = {
  v: 3 as const,
  endpoint: 'ws://192.168.1.20:6768',
  publicKeyB64: Buffer.alloc(32, 4).toString('base64'),
  ticket: Buffer.alloc(32, 9).toString('base64url'),
  deviceId: '1b1f6d1e-6d5f-4b0e-9a49-4c1d2d0f8a11',
  scope: 'runtime' as const,
  expiresAt: 1_800_000_000_000
}

describe('pairing ticket offer', () => {
  it('round-trips and keeps the secret out of any query string', () => {
    const { code, link } = encodePairingTicketOffer(offer)
    expect(link).toBe(`orca://pair#${code}`)
    expect(link).not.toContain('?')
    expect(decodePairingTicketCode(code)).toEqual(offer)
  })

  it('is refused by the v2 parser, so an older app reports an invalid code', () => {
    const { code, link } = encodePairingTicketOffer(offer)
    expect(parsePairingCode(code)).toBeNull()
    expect(parsePairingCode(link)).toBeNull()
  })

  it('rejects malformed codes and unknown fields', () => {
    expect(decodePairingTicketCode('%%%')).toBeNull()
    const extra = encodePairingTicketOffer(offer).code
    expect(decodePairingTicketCode(extra.slice(0, -4))).toBeNull()
    expect(() => encodePairingTicketOffer({ ...offer, ticket: 'short' })).toThrow()
  })
})
