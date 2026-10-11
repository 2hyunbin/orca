import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage } from '../../../src/shared/device-key-proof'
import { PAIRING_TICKET_RUNTIME_CAPABILITY } from '../../../src/shared/pairing-ticket-capability'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'
import { DeviceRegistry } from '../../../src/main/runtime/device-registry'
import { E2EEChannel } from '../../../src/main/runtime/rpc/e2ee-channel'
import { SimulatedMobileE2EEV2Peer } from '../../../src/main/runtime/relay/simulated-mobile-e2ee-v2-peer'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * Single-use tickets add a redemption shape inside E2EE v2, keyed rows with no fork parent, and the
 * `pairing.ticket.v1` capability. A released host must never be sent a redemption (it does not
 * advertise the capability), must refuse one harmlessly if it is, and must keep redeemed rows inert
 * and intact. A released client's token auth must keep working against this host.
 */
const SUITE_TIMEOUT_MS = 180_000

type RegistryLike = {
  validateToken(token: string): { deviceId: string } | null
  addDevice(name: string, scope: string): { deviceId: string; token: string }
  updateLastSeen(deviceId: string): void
}
type ChannelLike = { handleRawMessage(raw: string): void }
type ReleasedCrypto = {
  generateKeyPair: () => nacl.BoxKeyPair
  deriveSharedKey: (secretKey: Uint8Array, publicKey: Uint8Array) => Uint8Array
  encrypt: (plaintext: string, sharedKey: Uint8Array) => string
  decrypt: (frame: string, sharedKey: Uint8Array) => string | null
}

let ReleasedRegistry: new (userDataPath: string) => RegistryLike
let ReleasedChannel: new (ws: unknown, options: Record<string, unknown>) => ChannelLike
let releasedCapabilities: readonly string[]
let releasedCrypto: ReleasedCrypto

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registryModule, channelModule, protocolModule, cryptoModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/device-registry.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/e2ee-channel.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/e2ee-crypto.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's DeviceRegistry class; a changed shape fails the assertions below.
  ReleasedRegistry = registryModule.DeviceRegistry as typeof ReleasedRegistry
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's E2EEChannel class; a changed shape fails the assertions below.
  ReleasedChannel = channelModule.E2EEChannel as typeof ReleasedChannel
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's capability list; a changed shape fails the assertions below.
  releasedCapabilities = protocolModule.RUNTIME_CAPABILITIES as readonly string[]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's NaCl helpers; a changed shape fails the round trip below.
  releasedCrypto = cryptoModule as unknown as ReleasedCrypto
}, SUITE_TIMEOUT_MS)

function fakeSocket() {
  const sent: string[] = []
  return {
    sent,
    ws: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(data),
      close: vi.fn()
    }
  }
}

describe('cross-version: pairing tickets', () => {
  it('only this host advertises ticket redemption', () => {
    expect(RUNTIME_CAPABILITIES).toContain(PAIRING_TICKET_RUNTIME_CAPABILITY)
    expect(releasedCapabilities).not.toContain(PAIRING_TICKET_RUNTIME_CAPABILITY)
  })

  it('a released host refuses a redemption without creating anything', () => {
    const desktop = nacl.box.keyPair()
    const { sent, ws } = fakeSocket()
    const onReady = vi.fn()
    const onError = vi.fn()
    const resolveAuthenticatedDevice = vi.fn(() => null)
    const channel = new ReleasedChannel(ws, {
      serverSecretKey: desktop.secretKey,
      resolveAuthenticatedDevice,
      onReady,
      onError
    })
    const peer = new SimulatedMobileE2EEV2Peer(nacl.box.keyPair(), desktop.publicKey, null)
    channel.handleRawMessage(JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(sent[0]!))).toBe(true)
    const key = nacl.sign.keyPair()
    const proof = nacl.sign.detached(
      encodeDeviceProofMessage('redeem', Buffer.from(peer.transcriptHashB64, 'base64')),
      key.secretKey
    )
    channel.handleRawMessage(
      peer.sealText(
        JSON.stringify({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64: peer.transcriptHashB64,
          ticket: Buffer.alloc(32, 1).toString('base64url'),
          deviceId: 'reserved',
          devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
          deviceProofB64: Buffer.from(proof).toString('base64'),
          deviceLabel: 'Laptop'
        })
      )
    )
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(4001, expect.any(String))
    expect(resolveAuthenticatedDevice).not.toHaveBeenCalled()
  })

  it('a released registry keeps a redeemed row intact and inert', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-xv-ticket-'))
    const keyB64 = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    new DeviceRegistry(userDataPath).addRedeemedDeviceKey({
      deviceId: 'redeemed-1',
      label: 'Laptop',
      scope: 'runtime',
      grants: [],
      pairingReach: 'network',
      devicePublicKeyB64: keyB64
    })

    const released = new ReleasedRegistry(userDataPath)
    expect(released.validateToken('undefined')).toBeNull()
    // A released write (any token row change) must carry the redeemed row through.
    const token = released.addDevice('Phone', 'mobile')
    released.updateLastSeen(token.deviceId)

    const reread = new DeviceRegistry(userDataPath)
    expect(reread.lookupDeviceKey('redeemed-1')).toMatchObject({
      kind: 'found',
      device: { credentialKind: 'device-key', devicePublicKeyB64: keyB64, scope: 'runtime' }
    })
    expect(JSON.parse(readFileSync(join(userDataPath, 'orca-devices.json'), 'utf-8'))).toHaveLength(
      2
    )
  })

  it("a released client's token auth still works on a host that redeems tickets", () => {
    const desktop = nacl.box.keyPair()
    const { sent, ws } = fakeSocket()
    const onReady = vi.fn()
    const redeemTicket = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel only sends, closes and reads OPEN/readyState/bufferedAmount.
    const channel = new E2EEChannel(ws as unknown as ConstructorParameters<typeof E2EEChannel>[0], {
      serverSecretKey: desktop.secretKey,
      resolveAuthenticatedDevice: (token) =>
        token === 'device-token'
          ? {
              deviceId: 'device-1',
              deviceToken: token,
              scope: 'runtime',
              clientId: token,
              callerFingerprint: 'fingerprint',
              credentialRevision: 0
            }
          : null,
      redeemTicket,
      onReady,
      onError: vi.fn()
    })
    const client = releasedCrypto.generateKeyPair()
    const sharedKey = releasedCrypto.deriveSharedKey(client.secretKey, desktop.publicKey)
    channel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(client.publicKey).toString('base64')
      })
    )
    channel.handleRawMessage(
      releasedCrypto.encrypt(
        JSON.stringify({ type: 'e2ee_auth', deviceToken: 'device-token', clientCapabilities: [] }),
        sharedKey
      )
    )
    expect(onReady).toHaveBeenCalledOnce()
    expect(redeemTicket).not.toHaveBeenCalled()
    expect(JSON.parse(releasedCrypto.decrypt(sent[1]!, sharedKey)!)).toEqual({
      type: 'e2ee_authenticated'
    })
    channel.destroy()
  })
})
