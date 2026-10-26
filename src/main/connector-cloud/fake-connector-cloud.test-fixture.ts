// An in-process Orca Cloud connector speaking the real wire shapes, with a real sealed-challenge handshake.
import { randomBytes } from 'node:crypto'
import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  CONNECTOR_PATHS
} from '../../shared/connector-cloud-contract'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'
import { buildPushChallengeFixture } from '../runtime/push/push-host-challenge-fixtures'

export type FakeSignInAnswer =
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired'; interval?: number }
  | { status: 'authorized'; email: string; hostId?: string }

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

export class FakeConnectorCloud {
  readonly origin = 'https://connector.test'
  readonly requests: { path: string; body: unknown; token: string | null }[] = []
  /** Answers each sign-in poll in turn; the last one repeats. */
  signInAnswers: FakeSignInAnswer[] = [{ status: 'pending' }]
  /** Forces a status on every request to these paths, e.g. 404 from an older cloud. */
  readonly forced = new Map<string, Reply>()
  online = true
  /** How long a poll answer takes to arrive once it is ready. */
  pollReplyDelayMs = 0
  /** Requests never answer, as on a stalled network. */
  hang = false
  readonly linked = new Map<string, string>()
  /** The key the last sign-in start offered. */
  signInPublicKeyB64: string | null = null
  private polls = 0
  private readonly proofs = new Map<string, { proof: string; hostId: string }>()
  private readonly sessions = new Map<string, string>()
  private readonly helloed = new Set<string>()
  /** Every hello, ack and event the machine sent, in order. */
  readonly hellos: unknown[] = []
  readonly acks: unknown[] = []
  readonly events: unknown[] = []
  /** Poll answers in order; a poll with none queued is held until one is queued. */
  private readonly pollReplies: Reply[] = []
  private heldPoll: (() => void) | null = null

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (!this.online) {
      throw new TypeError('fetch failed')
    }
    if (this.hang) {
      return new Promise<never>(() => {})
    }
    const url = new URL(String(input))
    const path = url.pathname
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const auth = new Headers(init?.headers).get('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    this.requests.push({ path, body, token })
    const reply = this.forced.get(path) ?? (await this.route(path, body, token, init?.signal))
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }

  requestsTo(path: string): { body: unknown; token: string | null }[] {
    return this.requests.filter((request) => request.path === path)
  }

  /** The host id a session token was issued to, for routes added by later suites. */
  sessionHost(token: string | null): string | null {
    return token ? (this.sessions.get(token) ?? null) : null
  }

  /** Answers the next poll; `status` other than 200 is an error reply. */
  answerPoll(reply: Reply): void {
    this.pollReplies.push(reply)
    this.heldPoll?.()
  }

  /** Ends the current session, as an hour passing would. */
  expireSessions(): void {
    this.sessions.clear()
    this.helloed.clear()
  }

  private async route(
    path: string,
    body: unknown,
    token: string | null,
    signal: AbortSignal | null | undefined
  ): Promise<Reply> {
    const fields = isRecord(body) ? body : {}
    switch (path) {
      case CONNECTOR_PATHS.signInStart:
        this.signInPublicKeyB64 = String(fields.hostPublicKeyB64)
        this.polls = 0
        return {
          status: 201,
          body: {
            deviceCode: randomBytes(32).toString('base64url'),
            userCode: 'ABCD-EFGH',
            verificationUri: `${this.origin}/host-login`,
            expiresAt: Date.now() + 10 * 60_000,
            interval: 1
          }
        }
      case CONNECTOR_PATHS.signInPoll:
        return this.answerSignInPoll()
      case CONNECTOR_PATHS.hostChallenge:
        return this.issueChallenge(String(fields.hostPublicKeyB64))
      case CONNECTOR_PATHS.hostSession:
        return this.issueSession(String(fields.challengeId), String(fields.proofB64))
      case CONNECTOR_PATHS.signOut: {
        const hostId = this.sessionHost(token)
        if (!hostId) {
          return { status: 401, body: { error: 'session_expired' } }
        }
        this.linked.delete(hostId)
        return { status: 204 }
      }
      case CONNECTOR_PATHS.hello:
      case CONNECTOR_PATHS.poll:
      case CONNECTOR_PATHS.acks:
      case CONNECTOR_PATHS.events:
        return this.machineCall(path, body, token, signal)
      default:
        return { status: 404, body: { error: 'not_found' } }
    }
  }

  private async machineCall(
    path: string,
    body: unknown,
    token: string | null,
    signal: AbortSignal | null | undefined
  ): Promise<Reply> {
    const hostId = this.sessionHost(token)
    if (!hostId) {
      return { status: 401, body: { error: 'session_expired' } }
    }
    if (!this.linked.has(hostId)) {
      return { status: 403, body: { error: 'host_revoked' } }
    }
    if (path === CONNECTOR_PATHS.hello) {
      this.hellos.push(body)
      this.helloed.add(token ?? '')
      return { status: 204 }
    }
    if (path === CONNECTOR_PATHS.acks) {
      this.acks.push(...(isRecord(body) && Array.isArray(body.acks) ? body.acks : []))
      return { status: 204 }
    }
    if (path === CONNECTOR_PATHS.events) {
      this.events.push(...(isRecord(body) && Array.isArray(body.events) ? body.events : []))
      return { status: 204 }
    }
    if (!this.helloed.has(token ?? '')) {
      return { status: 409, body: { error: 'hello_required' } }
    }
    while (this.pollReplies.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.heldPoll = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true
        })
      })
      this.heldPoll = null
    }
    const reply = this.pollReplies.shift() ?? { status: 500 }
    if (this.pollReplyDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.pollReplyDelayMs))
    }
    return reply
  }

  private answerSignInPoll(): Reply {
    const answer = this.signInAnswers[Math.min(this.polls++, this.signInAnswers.length - 1)]
    if (answer.status !== 'authorized') {
      return { status: 200, body: { status: answer.status, interval: answer.interval ?? 1 } }
    }
    const hostId =
      answer.hostId ?? deriveRelayHostId(Buffer.from(this.signInPublicKeyB64 ?? '', 'base64'))
    this.linked.set(hostId, answer.email)
    return {
      status: 200,
      body: { status: 'authorized', interval: 1, hostId, account: { email: answer.email } }
    }
  }

  private issueChallenge(hostPublicKeyB64: string): Reply {
    const publicKey = Uint8Array.from(Buffer.from(hostPublicKeyB64, 'base64'))
    const hostId = deriveRelayHostId(publicKey)
    if (!this.linked.has(hostId)) {
      return { status: 403, body: { error: 'host_not_linked' } }
    }
    const challengeId = `challenge-${this.proofs.size + 1}`
    const { challenge, proof } = buildPushChallengeFixture({
      hostKeypair: { publicKey, secretKey: new Uint8Array(32), publicKeyB64: hostPublicKeyB64 },
      gatewayOrigin: this.origin,
      hostFingerprint: hostId,
      issuedAt: Date.now(),
      challengeId,
      domains: {
        transcript: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
        challengePlaintext: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
      }
    })
    this.proofs.set(challengeId, { proof, hostId })
    return { status: 200, body: challenge }
  }

  private issueSession(challengeId: string, proofB64: string): Reply {
    const expected = this.proofs.get(challengeId)
    this.proofs.delete(challengeId)
    if (!expected || expected.proof !== proofB64) {
      return { status: 403, body: { error: 'proof_rejected' } }
    }
    if (!this.linked.has(expected.hostId)) {
      return { status: 403, body: { error: 'host_not_linked' } }
    }
    const sessionToken = randomBytes(32).toString('base64url')
    this.sessions.set(sessionToken, expected.hostId)
    return {
      status: 200,
      body: { sessionToken, expiresAt: Date.now() + 60 * 60_000, hostId: expected.hostId }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
