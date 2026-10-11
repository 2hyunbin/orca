import { describe, expect, it } from 'vitest'
import { PAIR_SCAN_LINK_REFUSED_NOTICE, redirectIncomingPairingLink } from './incoming-pairing-link'

const refused = `/pair-scan?notice=${PAIR_SCAN_LINK_REFUSED_NOTICE}`

describe('redirectIncomingPairingLink', () => {
  it('sends a verified https link to the confirm screen with the fragment code', () => {
    expect(redirectIncomingPairingLink('https://www.onorca.dev/pair#abc_1-2')).toBe(
      '/pair-confirm?code=abc_1-2'
    )
  })

  it('refuses a pairing code carried by the custom scheme', () => {
    for (const url of [
      'orca://pair?code=abc123',
      'orca://pair#abc123',
      'ORCA://PAIR?code=abc123',
      'orca://pair/?code=abc123',
      'orca:///pair?code=abc123',
      'orca://pair-confirm?code=abc123',
      'orca:///pair-confirm?code=abc123',
      'exp+orca-mobile://pair-confirm?code=abc123'
    ]) {
      expect(redirectIncomingPairingLink(url), url).toBe(refused)
    }
  })

  it('opens the scanner for a bare custom-scheme pairing link', () => {
    expect(redirectIncomingPairingLink('orca://pair')).toBe('/pair-scan')
    expect(redirectIncomingPairingLink('orca://pair/')).toBe('/pair-scan')
  })

  it('refuses unverified https links that target a pairing screen', () => {
    expect(redirectIncomingPairingLink('https://evil.example/pair#abc123')).toBe(refused)
    expect(redirectIncomingPairingLink('https://www.onorca.dev/pair-confirm?code=abc')).toBe(
      refused
    )
    expect(redirectIncomingPairingLink('https://www.onorca.dev/pair?code=abc')).toBe(refused)
  })

  it('leaves every other link to the router', () => {
    expect(redirectIncomingPairingLink('orca://h/host-1/session/wt-1')).toBeNull()
    expect(redirectIncomingPairingLink('orca://pairing?code=abc')).toBeNull()
    expect(redirectIncomingPairingLink('orca://pair-scan')).toBeNull()
    expect(redirectIncomingPairingLink('/settings')).toBeNull()
  })
})
