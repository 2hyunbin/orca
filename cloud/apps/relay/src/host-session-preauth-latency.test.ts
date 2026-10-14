import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  buildHostProofMacInput,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  RELAY_CLOSE_CODE
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { CellReserveBook } from './cell-reserve-book.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { HostSessionRegistry, type CellReserveAdmission } from './host-session-registry.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

const CELL_ID = 'staging-gce-c1'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(''))
  })
}

function hostKey(): { keyPair: nacl.BoxKeyPair; identity: RelayTokenClaims } {
  const keyPair = nacl.box.keyPair()
  const relayHostId = createHash('sha256')
    .update(keyPair.publicKey)
    .digest('base64url')
    .slice(0, 16)
  return {
    keyPair,
    identity: {
      sub: 'user-1',
      prof: 'profile-1',
      relayHostId,
      purpose: 'host-control',
      exp: 4_102_444_800
    }
  }
}

function setup(input: { admitMode: 'db' | 'reserve'; databaseSays: boolean }) {
  let clock = 1_000_000
  const recordHostPreAuth = vi.fn<NonNullable<RelayRuntimeObserver['recordHostPreAuth']>>()
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordHostPreAuth
  } satisfies RelayRuntimeObserver
  const take = vi.fn<CellReserveBook['take']>((userId, relayHostId, epoch) => ({
    userId,
    relayHostId,
    epoch,
    directorId: 'director-1',
    expiresAt: clock + 60_000
  }))
  const reserveAdmission: CellReserveAdmission = {
    mode: () => input.admitMode,
    ticketEnforce: () => false,
    dryRunEnabled: () => false,
    databaseShedding: () => false,
    book: { take } as unknown as CellReserveBook,
    verifyLease: vi.fn(async () => 'absent' as const)
  }
  const verifyCellAssignment = vi.fn(async () => input.databaseSays)
  const registry = new HostSessionRegistry(
    config(),
    vi.fn(),
    {} as RelayCredentialStore,
    { verifyCellAssignment } as unknown as RelayAssignmentStore,
    new ProcessQueuedByteBudget(),
    observer,
    () => clock,
    Math.random,
    'incarnation-1',
    undefined,
    reserveAdmission
  )
  return {
    registry,
    recordHostPreAuth,
    verifyCellAssignment,
    take,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

function sendHello(socket: FakeSocket, keyPair: nacl.BoxKeyPair, relayHostId: string): void {
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'host-hello',
        v: 1,
        relayHostId,
        assignmentEpoch: 4,
        hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
        appVersion: '1.4.200'
      })
    ),
    false
  )
}

function answerChallenge(socket: FakeSocket, keyPair: nacl.BoxKeyPair): void {
  const challenge = JSON.parse(String(socket.send.mock.calls[0]?.[0])) as Record<string, string>
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64!, 'base64'),
    Buffer.from(challenge.nonceB64!, 'base64'),
    Buffer.from(challenge.relayEphemeralPublicKeyB64!, 'base64'),
    keyPair.secretKey
  )!
  const domainLength = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`).length
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domainLength,
    4
  ).getUint32(0, false)
  const transcriptStart = domainLength + 4
  const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
  const secret = plaintext.slice(transcriptStart + transcriptLength)
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'host-challenge-ack',
        challengeId: challenge.challengeId,
        proofB64: createHmac('sha256', secret)
          .update(buildHostProofMacInput(transcript))
          .digest('base64')
      })
    ),
    false
  )
}

describe('host pre-auth latency', () => {
  afterEach(() => vi.useRealTimers())

  it('records a booked hello on the reserve path, from accept to a verified proof', async () => {
    const h = setup({ admitMode: 'reserve', databaseSays: false })
    const { keyPair, identity } = hostKey()
    const socket = new FakeSocket()
    h.registry.acceptControl(socket as unknown as WebSocket, identity)
    h.advance(30)
    sendHello(socket, keyPair, identity.relayHostId)
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1))
    expect(h.recordHostPreAuth).not.toHaveBeenCalled()
    h.advance(45)
    answerChallenge(socket, keyPair)

    expect(h.take).toHaveBeenCalledOnce()
    expect(h.verifyCellAssignment).not.toHaveBeenCalled()
    expect(h.recordHostPreAuth).toHaveBeenCalledExactlyOnceWith('reserve', 'admitted', 75)
  })

  it('records a hello the database refuses on the db path', async () => {
    const h = setup({ admitMode: 'db', databaseSays: false })
    const { keyPair, identity } = hostKey()
    const socket = new FakeSocket()
    h.registry.acceptControl(socket as unknown as WebSocket, identity)
    h.advance(120)
    sendHello(socket, keyPair, identity.relayHostId)
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled())

    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, 'wrong assignment epoch')
    expect(h.take).not.toHaveBeenCalled()
    expect(h.recordHostPreAuth).toHaveBeenCalledExactlyOnceWith('db', 'refused', 120)
  })

  it('records a hello timeout as a db-path refusal, once', () => {
    vi.useFakeTimers()
    const h = setup({ admitMode: 'db', databaseSays: true })
    const { identity } = hostKey()
    const socket = new FakeSocket()
    h.registry.acceptControl(socket as unknown as WebSocket, identity)
    h.advance(2_000)
    vi.advanceTimersByTime(2_000)

    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
      'host hello timeout'
    )
    expect(h.recordHostPreAuth).toHaveBeenCalledExactlyOnceWith('db', 'refused', 2_000)
  })
})

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://c1.relay.example.test',
    cellUrl: 'https://c1.relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('0123456789abcdef0123456789abcdef'),
    role: 'cell',
    cellId: CELL_ID,
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}
