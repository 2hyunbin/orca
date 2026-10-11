import nacl from 'tweetnacl'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { createPairedE2EEClientHandshake } from '../../../src/shared/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../src/shared/paired-e2ee-node-primitives'
import { parsePairingTicketInput } from '../../../src/shared/pairing-ticket-offer'
import { parseWebPairingInput } from '../../../src/renderer/src/web/web-pairing'
import { resolveWebRuntimeAuthRejection } from '../../../src/renderer/src/web/web-runtime-auth-verdict'
import { createWebTicketCredentialSource } from '../../../src/renderer/src/web/web-ticket-credential-source'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * A ticket-capable web client against a released host: released hosts only hand out v2 codes,
 * which the client never treats as a ticket, and a forged v3 code is refused with bad_auth,
 * which the client reports as "this server does not accept single-use codes".
 */
const SUITE_TIMEOUT_MS = 180_000

type ChannelLike = { handleRawMessage(raw: string): void }

let ReleasedChannel: new (ws: unknown, options: Record<string, unknown>) => ChannelLike
let releasedEncodePairingOffer: (offer: Record<string, unknown>) => string

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [channelModule, pairingModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/e2ee-channel.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/pairing.ts')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's E2EEChannel class; a changed shape fails the assertions below.
  ReleasedChannel = channelModule.E2EEChannel as typeof ReleasedChannel
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's offer encoder; a changed shape fails the assertions below.
  releasedEncodePairingOffer = pairingModule.encodePairingOffer as typeof releasedEncodePairingOffer
}, SUITE_TIMEOUT_MS)

describe('cross-version: web ticket redemption against a released host', () => {
  it('never reads a released pairing code as a ticket', () => {
    const code = releasedEncodePairingOffer({
      v: 2,
      endpoint: 'ws://192.168.1.20:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.alloc(32, 4).toString('base64'),
      scope: 'runtime'
    })
    expect(parsePairingTicketInput(code)).toBeNull()
    expect(parseWebPairingInput(code)).toMatchObject({ v: 2, deviceToken: 'device-token' })
  })

  it('reports a forged redemption refused by a released host as unsupported', async () => {
    const desktop = nacl.box.keyPair()
    const sent: string[] = []
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => sent.push(data),
      close: vi.fn()
    }
    const onReady = vi.fn()
    const channel = new ReleasedChannel(ws, {
      serverSecretKey: desktop.secretKey,
      resolveAuthenticatedDevice: () => null,
      onReady,
      onError: vi.fn()
    })
    const handshake = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
      framing: 'v2',
      transport: 'direct'
    })
    channel.handleRawMessage(handshake.helloText())
    expect(handshake.acceptReadyText(sent[0]!)).toBe('accepted')
    const signing = nacl.sign.keyPair()
    const source = createWebTicketCredentialSource({
      ticket: Buffer.alloc(32, 9).toString('base64url'),
      deviceId: 'reserved-1',
      key: {
        publicKeyB64: Buffer.from(signing.publicKey).toString('base64'),
        sign: async (message) => nacl.sign.detached(message, signing.secretKey)
      },
      deviceLabel: 'Chrome on macOS',
      ephemeral: false
    })
    const plan = source.nextPlan(true)
    if (plan instanceof Promise || plan.kind !== 'redeem') {
      throw new Error('expected a redemption plan')
    }
    channel.handleRawMessage(
      await handshake.sealAuth({
        kind: 'ticket',
        ticket: plan.ticket,
        deviceId: plan.deviceId,
        devicePublicKeyB64: plan.key.publicKeyB64,
        deviceLabel: plan.deviceLabel,
        sign: plan.key.sign
      })
    )
    expect(onReady).not.toHaveBeenCalled()
    const reply = handshake.classifyAuthReply(handshake.channel.openText(sent[1]!)!)
    if (reply.kind !== 'rejected') {
      throw new Error('expected a refusal')
    }
    expect(await resolveWebRuntimeAuthRejection(plan, reply, source)).toEqual({
      kind: 'failed',
      reason: 'ticket-unsupported'
    })
  })
})
