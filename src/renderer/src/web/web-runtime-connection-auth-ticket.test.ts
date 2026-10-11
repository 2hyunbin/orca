// @vitest-environment happy-dom

import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { createPairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { derivePairingComparisonCode } from '../../../shared/pairing-comparison-code-noble'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/paired-e2ee-node-primitives'
import {
  createMobileE2EEV2Fixture,
  MOBILE_E2EE_V2_VECTOR
} from '../../../shared/mobile-e2ee-v2-fixtures'
import { openMobileE2EEV2Frame } from '../../../shared/mobile-e2ee-v2-framing'
import { WebRuntimeConnectionAuth } from './web-runtime-connection-auth'
import { createWebTicketCredentialSource } from './web-ticket-credential-source'

const signing = nacl.sign.keyPair()

// The normative v2 vector stands in for a host: its keys open what the client seals.
function readyHandshake() {
  const fixture = createMobileE2EEV2Fixture()
  const handshake = createPairedE2EEClientHandshake({
    primitives: { ...NODE_PAIRED_E2EE_PRIMITIVES, deriveSharedKey: () => fixture.sharedSecret },
    hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
    framing: 'v2',
    transport: 'relay',
    relayHostId: fixture.hello.context.relayHostId,
    clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
    clientNonce: new Uint8Array(32).fill(2)
  })
  handshake.helloText()
  expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('accepted')
  const openAuth = (frame: string): Record<string, unknown> =>
    JSON.parse(
      Buffer.from(
        openMobileE2EEV2Frame({
          frame: Buffer.from(frame, 'base64'),
          key: Buffer.from(MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex, 'hex'),
          sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
          direction: 'mobile-to-desktop',
          payloadKind: 'text',
          expectedCounter: 0n
        })!
      ).toString()
    )
  return { handshake, openAuth }
}

function ticketAuth(onPairingComparisonCode = vi.fn()) {
  const credential = createWebTicketCredentialSource({
    ticket: Buffer.alloc(32, 9).toString('base64url'),
    deviceId: 'reserved-1',
    key: {
      publicKeyB64: Buffer.from(signing.publicKey).toString('base64'),
      sign: async (message) => nacl.sign.detached(message, signing.secretKey)
    },
    deviceLabel: 'Chrome on macOS',
    ephemeral: false
  })
  const auth = new WebRuntimeConnectionAuth(
    {
      endpoint: 'ws://host:6768',
      hostPublicKeyB64: createMobileE2EEV2Fixture().ready.desktopPublicKeyB64,
      credential: { kind: 'token', deviceToken: 'migrated:reserved-1' }
    },
    { credential, onPairingComparisonCode, retryLater: vi.fn() }
  )
  let plan: Parameters<Parameters<WebRuntimeConnectionAuth['open']>[0]>[0] | null = null
  auth.open((next) => {
    plan = next
  })
  return { auth, credential, onPairingComparisonCode, plan: () => plan! }
}

describe('web ticket redemption over the connection auth', () => {
  it('sends the redemption, shows the matching comparison code and waits out the approval', async () => {
    const { auth, onPairingComparisonCode, plan } = ticketAuth()
    expect(plan().kind).toBe('redeem')
    expect(auth.handshakeTimeoutMs(plan())).toBeGreaterThan(2 * 60_000)
    const { handshake, openAuth } = readyHandshake()
    const send = vi.fn()
    await auth.sendAuth({
      handshake,
      fallbackToken: 'migrated:reserved-1',
      isCurrent: () => true,
      send,
      fail: vi.fn()
    })
    const auth_ = openAuth(send.mock.calls[0]![0])
    expect(auth_).toMatchObject({
      type: 'e2ee_auth',
      v: 2,
      deviceId: 'reserved-1',
      deviceLabel: 'Chrome on macOS'
    })
    expect(auth_).not.toHaveProperty('deviceToken')
    expect(onPairingComparisonCode).toHaveBeenCalledWith(
      derivePairingComparisonCode(Buffer.from(MOBILE_E2EE_V2_VECTOR.transcriptHashHex, 'hex'))
    )
  })

  it('after a lost reply signs in with the reserved id first', async () => {
    const { auth, credential, plan } = ticketAuth()
    const { handshake } = readyHandshake()
    await auth.sendAuth({
      handshake,
      fallbackToken: 'x',
      isCurrent: () => true,
      send: vi.fn(),
      fail: vi.fn()
    })
    auth.socketClosed()
    expect(plan().kind).toBe('redeem')
    expect(credential.nextPlan(true)).toMatchObject({ kind: 'device-key', deviceId: 'reserved-1' })
  })

  it('stops redeeming once the host authenticated the redemption', async () => {
    const { auth, credential } = ticketAuth()
    auth.authenticated()
    expect(credential.nextPlan(true)).toMatchObject({ kind: 'device-key' })
    expect(auth.outbound({ id: '1', deviceToken: 'migrated:reserved-1' })).toEqual({ id: '1' })
  })
})
