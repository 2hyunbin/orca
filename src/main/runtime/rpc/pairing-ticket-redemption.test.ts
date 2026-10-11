import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage, type DeviceProofPurpose } from '../../../shared/device-key-proof'
import { derivePairingComparisonCode } from '../../../shared/pairing-comparison-code-noble'
import { DeviceRegistry } from '../device-registry'
import { PairingTicketBook, type PairingTicketMint } from '../pairing-ticket-book'
import {
  redeemPairingTicket,
  type PairingTicketApprovalRequest,
  type PairingTicketApprover
} from '../pairing-ticket-redemption'
import { SimulatedMobileE2EEV2Peer } from '../relay/simulated-mobile-e2ee-v2-peer'
import { encrypt, generateKeyPair } from './e2ee-crypto'
import {
  MobileSocketWiring,
  type MobileSocketTransport,
  type MobileSocketTransportMetadata
} from './mobile-socket-wiring'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send = vi.fn((data: string | Buffer) => this.sent.push(data))
  readonly close = vi.fn()
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)
  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }
  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }
  receive(ws: FakeSocket, message: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only sends, closes and reads OPEN/readyState/bufferedAmount.
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
  disconnect(ws: FakeSocket): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    this.closeHandler?.(null, ws as unknown as WebSocket, false)
  }
}

const desktop = generateKeyPair()
const cliTicket: PairingTicketMint = {
  issuedVia: 'owner-cli',
  scope: 'runtime',
  grants: [],
  reach: 'network',
  ttlMs: 30 * 60_000
}
const uiTicket: PairingTicketMint = { ...cliTicket, issuedVia: 'local-ui', ttlMs: 10 * 60_000 }

function sign(key: nacl.SignKeyPair, purpose: DeviceProofPurpose, transcriptHashB64: string) {
  const message = encodeDeviceProofMessage(purpose, Buffer.from(transcriptHashB64, 'base64'))
  return Buffer.from(nacl.sign.detached(message, key.secretKey)).toString('base64')
}

function harness(
  options: { approver?: PairingTicketApprover; metadata?: MobileSocketTransportMetadata } = {}
) {
  const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-ticket-')))
  const tickets = new PairingTicketBook()
  const transport = new FakeTransport()
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: {
      publicKey: desktop.publicKey,
      secretKey: desktop.secretKey,
      publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
    },
    onText: vi.fn(),
    onBinary: vi.fn(),
    onClose: vi.fn(),
    isReservedDeviceId: (deviceId) => tickets.isReservedDeviceId(deviceId),
    redeemTicket: (redemption, context) =>
      redeemPairingTicket({
        tickets,
        registry,
        approver: options.approver ?? null,
        redemption,
        transcriptHashB64: context.transcriptHashB64,
        signal: context.signal
      })
  })
  wiring.attachTransport(transport, () => options.metadata ?? { transport: 'direct' })

  /** Opens a v2 socket, sends `auth(transcriptHashB64)`; `reply()` resolves the sealed verdict. */
  function connect(auth: (transcriptHashB64: string) => Record<string, unknown>) {
    const ws = new FakeSocket()
    const peer = new SimulatedMobileE2EEV2Peer(
      nacl.box.keyPair(),
      desktop.publicKey,
      options.metadata?.transport === 'relay' ? options.metadata.relayHostId : null
    )
    transport.receive(ws, JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(String(ws.sent[0])))).toBe(true)
    const transcriptHashB64 = peer.transcriptHashB64
    transport.receive(
      ws,
      peer.sealText(
        JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, ...auth(transcriptHashB64) })
      )
    )
    const reply = async (): Promise<Record<string, unknown>> => {
      await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(1))
      return JSON.parse(peer.openText(String(ws.sent[1]))!)
    }
    return { ws, transcriptHashB64, reply }
  }
  return { registry, tickets, transport, connect }
}

function redemptionFor(
  ticket: { ticket: string; deviceId: string },
  key: nacl.SignKeyPair,
  overrides: { purpose?: DeviceProofPurpose; deviceLabel?: string } = {}
) {
  return (transcriptHashB64: string) => ({
    ticket: ticket.ticket,
    deviceId: ticket.deviceId,
    devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
    deviceProofB64: sign(key, overrides.purpose ?? 'redeem', transcriptHashB64),
    deviceLabel: overrides.deviceLabel ?? 'Laptop‮ browser\u0007'
  })
}

describe('pairing ticket redemption (host)', () => {
  it('redeems a CLI ticket once into a keyed row the client can then sign in with', async () => {
    const { registry, tickets, connect } = harness()
    const minted = tickets.mint({ ...cliTicket, grants: ['desktop-control'] })
    const key = nacl.sign.keyPair()

    const first = connect(redemptionFor(minted, key))
    expect(await first.reply()).toEqual({
      type: 'e2ee_authenticated',
      v: 2,
      transcriptHashB64: first.transcriptHashB64
    })
    expect(registry.getDevice(minted.deviceId)).toMatchObject({
      credentialKind: 'device-key',
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      name: 'Laptop browser',
      scope: 'runtime',
      grants: ['desktop-control']
    })
    expect(registry.getDevice(minted.deviceId)?.token).toBeUndefined()

    // Lost reply: the client retries with key auth under the reserved id.
    const keyed = connect((hash) => ({
      deviceId: minted.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(await keyed.reply()).toMatchObject({ type: 'e2ee_authenticated' })

    const again = connect(redemptionFor(minted, nacl.sign.keyPair()))
    expect(await again.reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'ticket_consumed' }
    })
    expect(again.ws.close).toHaveBeenCalledWith(4001, 'Pairing ticket refused')
  })

  it('accepts the optional ephemeral flag and keeps the row session-only', async () => {
    const { registry, tickets, connect } = harness()
    const minted = tickets.mint(cliTicket)
    const key = nacl.sign.keyPair()
    const session = connect((hash) => ({ ...redemptionFor(minted, key)(hash), ephemeral: true }))
    expect(await session.reply()).toMatchObject({ type: 'e2ee_authenticated' })
    expect(registry.getDevice(minted.deviceId)?.ephemeral).toBe(true)
  })

  it('refuses a proof made for another purpose and burns the ticket after repeated failures', async () => {
    const { tickets, connect } = harness()
    const minted = tickets.mint(cliTicket)
    const key = nacl.sign.keyPair()
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = connect(redemptionFor(minted, key, { purpose: 'auth' }))
      expect(await wrong.reply()).toEqual({ type: 'e2ee_error', error: { code: 'bad_proof' } })
    }
    const honest = connect(redemptionFor(minted, key))
    expect(await honest.reply()).toEqual({ type: 'e2ee_error', error: { code: 'ticket_invalid' } })
  })

  it('refuses a redemption whose device id is not the one the ticket reserved', async () => {
    const { registry, tickets, connect } = harness()
    const minted = tickets.mint(cliTicket)
    const forged = connect(
      redemptionFor({ ...minted, deviceId: 'attacker-chosen' }, nacl.sign.keyPair())
    )
    expect(await forged.reply()).toEqual({ type: 'e2ee_error', error: { code: 'ticket_invalid' } })
    expect(registry.listDevices()).toEqual([])
    // The reservation stays usable by the real holder.
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('locked')
  })

  it('refuses a key that already belongs to a device', async () => {
    const { registry, tickets, connect } = harness()
    const key = nacl.sign.keyPair()
    const first = tickets.mint(cliTicket)
    expect(await connect(redemptionFor(first, key)).reply()).toMatchObject({
      type: 'e2ee_authenticated'
    })
    const second = tickets.mint(cliTicket)
    expect(await connect(redemptionFor(second, key)).reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'device_key_in_use' }
    })
    expect(registry.listDevices()).toHaveLength(1)
  })

  it('refuses redemption over relay sockets', async () => {
    const { tickets, connect } = harness({
      metadata: {
        transport: 'relay',
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId: 'relay-device',
        basisConnId: 'conn',
        credentialKind: 'invite'
      }
    })
    const minted = tickets.mint(cliTicket)
    expect(await connect(redemptionFor(minted, nacl.sign.keyPair())).reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'bad_auth' }
    })
  })

  it('refuses the redemption shape over legacy framing', () => {
    const { registry, tickets, transport } = harness()
    const minted = tickets.mint(cliTicket)
    const ws = new FakeSocket()
    const client = nacl.box.keyPair()
    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(client.publicKey).toString('base64')
      })
    )
    const shared = nacl.box.before(desktop.publicKey, client.secretKey)
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', ticket: minted.ticket }), shared)
    )
    expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid e2ee_auth')
    expect(registry.listDevices()).toEqual([])
  })

  it('asks the owner with the comparison code both screens derive, and honours allow and deny', async () => {
    const requests: PairingTicketApprovalRequest[] = []
    let decision: 'allow' | 'deny' = 'deny'
    const { registry, tickets, connect } = harness({
      approver: async (request) => {
        requests.push(request)
        return { decision }
      }
    })
    const denied = tickets.mint(uiTicket)
    const deniedSocket = connect(redemptionFor(denied, nacl.sign.keyPair()))
    expect(await deniedSocket.reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'approval_denied' }
    })
    expect(tickets.beginRedemption(denied.ticket).kind).toBe('invalid')

    decision = 'allow'
    const allowed = tickets.mint(uiTicket)
    const key = nacl.sign.keyPair()
    const allowedSocket = connect(redemptionFor(allowed, key))
    expect(await allowedSocket.reply()).toMatchObject({ type: 'e2ee_authenticated' })
    const request = requests.at(-1)!
    expect(request.comparisonCode).toBe(
      derivePairingComparisonCode(Buffer.from(allowedSocket.transcriptHashB64, 'base64'))
    )
    expect(request).toMatchObject({
      scope: 'runtime',
      grants: [],
      deviceLabel: 'Laptop browser',
      replaces: []
    })
    expect(request.deviceKeyFingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/)
    expect(registry.getDevice(allowed.deviceId)).toMatchObject({ credentialKind: 'device-key' })
  })

  it('denies a local-UI ticket when no owner can be asked', async () => {
    const { tickets, connect } = harness()
    const minted = tickets.mint(uiTicket)
    expect(await connect(redemptionFor(minted, nacl.sign.keyPair())).reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'approval_denied' }
    })
  })

  it('holds the ticket while the owner decides, so a racing redemption is refused', async () => {
    let answer: ((decision: 'allow' | 'deny') => void) | null = null
    const { tickets, connect } = harness({
      approver: () =>
        new Promise((resolve) => {
          answer = (decision) => resolve({ decision })
        })
    })
    const minted = tickets.mint(uiTicket)
    const victim = connect(redemptionFor(minted, nacl.sign.keyPair(), { deviceLabel: 'Mine' }))
    await vi.waitFor(() => expect(answer).not.toBeNull())
    const thief = connect(redemptionFor(minted, nacl.sign.keyPair(), { deviceLabel: 'Thief' }))
    expect(await thief.reply()).toEqual({ type: 'e2ee_error', error: { code: 'ticket_consumed' } })
    answer!('allow')
    expect(await victim.reply()).toMatchObject({ type: 'e2ee_authenticated' })
  })

  it('burns the ticket when the socket closes while the owner decides', async () => {
    let signal: AbortSignal | null = null
    const { registry, tickets, transport, connect } = harness({
      approver: (request) => {
        signal = request.signal
        return new Promise(() => {})
      }
    })
    const minted = tickets.mint(uiTicket)
    const pending = connect(redemptionFor(minted, nacl.sign.keyPair()))
    await vi.waitFor(() => expect(signal).not.toBeNull())
    transport.disconnect(pending.ws)
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    await vi.waitFor(() => expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid'))
    expect(registry.listDevices()).toEqual([])
  })
})

describe('pairing ticket redemption failures never revoke a pending key', () => {
  it('answers key auth for an unredeemed reserved id with registry_unavailable, not device_revoked', async () => {
    const { tickets, connect } = harness()
    const minted = tickets.mint(cliTicket)
    const key = nacl.sign.keyPair()
    const early = connect((hash) => ({
      deviceId: minted.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(await early.reply()).toEqual({
      type: 'e2ee_error',
      error: { code: 'registry_unavailable' }
    })
  })

  it('burns the ticket when the approval step throws unexpectedly', async () => {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-ticket-')))
    const tickets = new PairingTicketBook()
    const minted = tickets.mint(uiTicket)
    const transcriptHashB64 = Buffer.alloc(32, 7).toString('base64')
    vi.spyOn(registry, 'listDevices').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(
      redeemPairingTicket({
        tickets,
        registry,
        approver: async () => ({ decision: 'allow' }),
        transcriptHashB64,
        signal: new AbortController().signal,
        redemption: {
          kind: 'redemption',
          ephemeral: false,
          ...redemptionFor(minted, nacl.sign.keyPair())(transcriptHashB64)
        }
      })
    ).rejects.toThrow('boom')
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
  })
})

describe('redeemPairingTicket approval rules', () => {
  function direct(approver: PairingTicketApprover | null, approvalTimeoutMs?: number) {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-ticket-')))
    const tickets = new PairingTicketBook()
    const transcriptHashB64 = Buffer.alloc(32, 7).toString('base64')
    const redeem = (minted: { ticket: string; deviceId: string }, deviceLabel = 'Laptop') => {
      const key = nacl.sign.keyPair()
      return redeemPairingTicket({
        tickets,
        registry,
        approver,
        approvalTimeoutMs,
        transcriptHashB64,
        signal: new AbortController().signal,
        redemption: {
          kind: 'redemption',
          ephemeral: false,
          ...redemptionFor(minted, key, { deviceLabel })(transcriptHashB64)
        }
      })
    }
    return { registry, tickets, redeem, transcriptHashB64 }
  }

  it('treats an unanswered prompt as a denial once the approval window ends', async () => {
    const { tickets, redeem } = direct(() => new Promise(() => {}), 20)
    const minted = tickets.mint(uiTicket)
    expect(await redeem(minted)).toEqual({ ok: false, code: 'approval_denied' })
    expect(tickets.beginRedemption(minted.ticket).kind).toBe('invalid')
  })

  it('makes the owner type the code before a same-named device is replaced', async () => {
    let typedCode: string | undefined
    const seen: PairingTicketApprovalRequest[] = []
    const { registry, tickets, redeem, transcriptHashB64 } = direct(async (request) => {
      seen.push(request)
      return { decision: 'allow', typedCode }
    })
    // A stored name with invisible characters still counts as the same device.
    const existing = registry.addDevice('Lap\u200btop', 'runtime')

    const untyped = tickets.mint(uiTicket)
    expect(await redeem(untyped)).toEqual({ ok: false, code: 'approval_denied' })
    expect(seen[0]?.replaces).toEqual([{ deviceId: existing.deviceId, name: 'Laptop' }])

    typedCode = ' xxxxxx '
    expect(await redeem(tickets.mint(uiTicket))).toEqual({ ok: false, code: 'approval_denied' })

    typedCode = derivePairingComparisonCode(Buffer.from(transcriptHashB64, 'base64')).toLowerCase()
    const typed = tickets.mint(uiTicket)
    const result = await redeem(typed)
    expect(result).toMatchObject({ ok: true, replacedDeviceIds: [existing.deviceId] })

    // A different label needs no typing.
    typedCode = undefined
    expect(await redeem(tickets.mint(uiTicket), 'Tablet')).toMatchObject({ ok: true })
  })

  it('never asks for approval on an owner-minted headless ticket', async () => {
    const approver = vi.fn()
    const { tickets, redeem } = direct(approver)
    expect(await redeem(tickets.mint(cliTicket))).toMatchObject({ ok: true })
    expect(approver).not.toHaveBeenCalled()
  })
})
