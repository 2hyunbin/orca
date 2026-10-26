import type { z } from 'zod'
import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  CONNECTOR_PATHS,
  ConnectorHostChallengeResponse,
  ConnectorHostSessionResponse
} from '../../shared/connector-cloud-contract'
import { answerHostChallenge } from '../runtime/host-challenge-proof'
import type { E2EEKeypair } from '../runtime/e2ee-keypair'
import { connectorHostId } from './connector-host-identity'
import {
  requestConnector,
  UNREADABLE_ANSWER,
  type ConnectorFailure,
  type ConnectorRequest,
  type ConnectorResult
} from './connector-cloud-request'

// Renew early so a session cannot lapse between the check and the request.
const SESSION_RENEWAL_MARGIN_MS = 60_000

export const CONNECTOR_HOST_PROOF_DOMAINS = {
  transcript: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  challengePlaintext: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
}

/** `generation` counts sessions this key opened; each new one starts a fresh cloud-side session state. */
type Session = { token: string; expiresAt: number; generation: number }

export type ConnectorCallOptions = Pick<ConnectorRequest, 'method' | 'timeoutMs' | 'signal'> & {
  /** Send only on this session; a renewed one answers session_expired without sending. */
  generation?: number
}

const SESSION_GONE: ConnectorFailure = {
  ok: false,
  status: 401,
  error: 'session_expired',
  retryAfterMs: null
}

/** Push's sealed-challenge handshake under the connector's domains; one session shared by every call. */
export class ConnectorHostSession {
  readonly hostId: string
  private session: Session | null = null
  private opened = 0
  private pending: Promise<ConnectorResult<Session>> | null = null

  constructor(
    private readonly origin: string,
    private readonly keypair: E2EEKeypair,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly now: () => number = Date.now
  ) {
    this.hostId = connectorHostId(keypair)
  }

  /** The generation of a live session, opening one if needed. */
  async current(): Promise<ConnectorResult<number>> {
    const session = await this.ensure()
    return session.ok ? { ok: true, value: session.value.generation } : session
  }

  /** An authorized call; a 401 opens one new session and tries once more, unless pinned to a generation. */
  async call<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema,
    options: ConnectorCallOptions = {}
  ): Promise<ConnectorResult<z.infer<TSchema>>> {
    const session = await this.ensure()
    if (!session.ok) {
      return session
    }
    const pinned = options.generation
    if (pinned !== undefined && session.value.generation !== pinned) {
      return SESSION_GONE
    }
    const result = await this.send(session.value, path, body, schema, options)
    if (result.ok || result.status !== 401) {
      return result
    }
    // Drop only the refused token; a concurrent call may already hold its replacement.
    if (this.session === session.value) {
      this.session = null
    }
    if (pinned !== undefined) {
      return result
    }
    const renewed = await this.ensure()
    return renewed.ok ? await this.send(renewed.value, path, body, schema, options) : renewed
  }

  private send<TSchema extends z.ZodType>(
    session: Session,
    path: string,
    body: unknown,
    schema: TSchema,
    options: ConnectorCallOptions
  ): Promise<ConnectorResult<z.infer<TSchema>>> {
    const url = `${this.origin}${path}`
    return requestConnector(
      { ...options, fetchImpl: this.fetchImpl, url, body, token: session.token },
      schema
    )
  }

  private async ensure(): Promise<ConnectorResult<Session>> {
    const cached = this.session
    if (cached && cached.expiresAt - SESSION_RENEWAL_MARGIN_MS > this.now()) {
      return { ok: true, value: cached }
    }
    // Concurrent calls share one handshake rather than each spending a challenge.
    this.pending ??= this.open().finally(() => {
      this.pending = null
    })
    return await this.pending
  }

  private async open(): Promise<ConnectorResult<Session>> {
    const challenge = await this.post(
      CONNECTOR_PATHS.hostChallenge,
      { v: 1, hostPublicKeyB64: this.keypair.publicKeyB64 },
      ConnectorHostChallengeResponse
    )
    if (!challenge.ok) {
      return challenge
    }
    const proofB64 = answerHostChallenge(
      challenge.value,
      {
        gatewayOrigin: this.origin,
        hostFingerprint: this.hostId,
        hostPublicKey: this.keypair.publicKey,
        hostSecretKey: this.keypair.secretKey,
        now: this.now
      },
      CONNECTOR_HOST_PROOF_DOMAINS
    )
    if (!proofB64) {
      return UNREADABLE_ANSWER
    }
    const session = await this.post(
      CONNECTOR_PATHS.hostSession,
      { v: 1, challengeId: challenge.value.challengeId, proofB64 },
      ConnectorHostSessionResponse
    )
    if (!session.ok) {
      return session
    }
    // A session issued for another host is never usable here.
    if (session.value.hostId !== this.hostId) {
      return UNREADABLE_ANSWER
    }
    this.session = {
      token: session.value.sessionToken,
      expiresAt: session.value.expiresAt,
      generation: ++this.opened
    }
    return { ok: true, value: this.session }
  }

  private post<TSchema extends z.ZodType>(path: string, body: unknown, schema: TSchema) {
    return requestConnector(
      { fetchImpl: this.fetchImpl, url: `${this.origin}${path}`, body },
      schema
    )
  }
}
