import { describe, expect, it } from 'vitest'
import { parsePairingCode } from './pairing'
import {
  decodePairingTicketCode,
  encodePairingTicketOffer,
  parsePairingTicketInput
} from './pairing-ticket-offer'
import { buildVerifiedPairingLink } from './verified-pairing-link'

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
  it('links only through the verified https link, secret in the fragment', () => {
    const { code, link } = encodePairingTicketOffer(offer)
    // Why: any app can claim orca://, and a headless ticket redeems without approval.
    expect(link).toBe(buildVerifiedPairingLink(code))
    expect(link.startsWith('https://')).toBe(true)
    expect(link).not.toContain('?')
    expect(decodePairingTicketCode(code)).toEqual(offer)
  })

  it('accepts a bare code or the verified link, and refuses a ticket in an orca:// URL', () => {
    const { code, link } = encodePairingTicketOffer(offer)
    expect(parsePairingTicketInput(code)).toEqual(offer)
    expect(parsePairingTicketInput(` ${link} `)).toEqual(offer)
    expect(parsePairingTicketInput(`orca://pair#${code}`)).toBeNull()
    expect(parsePairingTicketInput(`orca://pair?code=${code}`)).toBeNull()
    expect(parsePairingTicketInput(`https://evil.example/pair#${code}`)).toBeNull()
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
