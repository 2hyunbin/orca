import { describe, expect, it } from 'vitest'
import { encodePairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import { decideWebPairingStartup, parseWebPairingInput, type WebPairingOffer } from './web-pairing'

describe('web pairing input', () => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({ ...offer, ...overrides }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('parses query-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('still parses legacy hash-form pairing URLs', () => {
    expect(parseWebPairingInput(`orca://pair#${encodeOffer()}`)).toEqual(offer)
  })

  it('preserves optional device scope metadata', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'mobile' })}`)).toEqual({
      ...offer,
      scope: 'mobile'
    })
  })

  it('preserves optional paired device identity', () => {
    expect(
      parseWebPairingInput(`orca://pair?code=${encodeOffer({ pairedDeviceId: 'paired-device-a' })}`)
    ).toEqual({
      ...offer,
      pairedDeviceId: 'paired-device-a'
    })
  })

  it.each([
    ['wss://proxy.example:443/orca/runtime', 'wss://proxy.example:443/orca/runtime'],
    ['https://proxy.example/orca/runtime', 'wss://proxy.example/orca/runtime'],
    ['http://proxy.example:8080/orca/runtime', 'ws://proxy.example:8080/orca/runtime']
  ])('preserves reverse-proxy endpoint routing for %s', (endpoint, expected) => {
    expect(parseWebPairingInput(encodeOffer({ endpoint }))).toMatchObject({ endpoint: expected })
  })

  it('keeps a readable host descriptor and drops an unreadable one without refusing', () => {
    const hostDescriptor = { installationId: '11111111-1111-4111-8111-111111111111' }
    expect(parseWebPairingInput(encodeOffer({ hostDescriptor }))).toEqual({
      ...offer,
      hostDescriptor
    })
    expect(parseWebPairingInput(encodeOffer({ hostDescriptor: { installationId: 7 } }))).toEqual(
      offer
    )
  })

  it('treats invalid device scope metadata as unknown', () => {
    expect(parseWebPairingInput(`orca://pair?code=${encodeOffer({ scope: 'admin' })}`)).toEqual(
      offer
    )
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`orca://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`orca://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })

  it('auto-saves scoped runtime offers during web startup', () => {
    const input = `orca://pair?code=${encodeOffer({ scope: 'runtime' })}`
    expect(
      decideWebPairingStartup({ initialPairingInput: input, hasStoredEnvironment: false })
    ).toEqual({
      kind: 'auto-save-runtime-offer',
      offer: { ...offer, scope: 'runtime' }
    })
  })

  it('shows the connect screen for mobile-scope and legacy unknown-scope offers', () => {
    const mobileInput = `orca://pair?code=${encodeOffer({ scope: 'mobile' })}`
    const legacyInput = `orca://pair?code=${encodeOffer()}`

    expect(
      decideWebPairingStartup({ initialPairingInput: mobileInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: mobileInput })
    expect(
      decideWebPairingStartup({ initialPairingInput: legacyInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: legacyInput })
  })

  it('routes a single-use code in the address to the connect screen so it is cleared and redeemed', () => {
    const { code, link } = encodePairingTicketOffer({
      v: 3,
      endpoint: 'ws://192.168.1.20:6768',
      publicKeyB64: Buffer.alloc(32, 4).toString('base64'),
      ticket: Buffer.alloc(32, 9).toString('base64url'),
      deviceId: '1b1f6d1e-6d5f-4b0e-9a49-4c1d2d0f8a11',
      scope: 'runtime',
      expiresAt: 1_800_000_000_000
    })
    for (const input of [code, link]) {
      expect(
        decideWebPairingStartup({ initialPairingInput: input, hasStoredEnvironment: true })
      ).toEqual({ kind: 'show-connect', initialPairingInput: input })
    }
    expect(
      decideWebPairingStartup({
        initialPairingInput: `orca://pair#${code}`,
        hasStoredEnvironment: true
      })
    ).toEqual({ kind: 'use-stored-environment' })
  })

  it('uses a stored environment when no fresh valid pairing offer is present', () => {
    expect(
      decideWebPairingStartup({ initialPairingInput: null, hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
    expect(
      decideWebPairingStartup({ initialPairingInput: 'not a code', hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
  })
})
