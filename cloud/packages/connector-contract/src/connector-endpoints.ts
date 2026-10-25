import { z } from 'zod'

// Every route is POST except hello (PUT). Machine routes take `Authorization: Bearer <sessionToken>`.
export const CONNECTOR_PATHS = {
  signInStart: '/v1/host/auth/start',
  signInPoll: '/v1/host/auth/poll',
  signOut: '/v1/host/auth/unbind',
  // Push's challenge/session shapes (@orca-cloud/push-contract) under the connector domains.
  hostChallenge: '/v1/host/challenge',
  hostSession: '/v1/host/session',
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies'
} as const

// Push's transcript and sealed-challenge layout, with domains no push proof can answer.
export const CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-connector-host-proof/v1'
export const CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-connector-host-challenge/v1'

export const CONNECTOR_ERROR_CODES = [
  'session_expired',
  'host_not_linked',
  'host_revoked',
  'hello_required',
  'client_too_old',
  'not_this_hosts_thread'
] as const
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number]

// Codes stay open so an older machine reads a newer one as a plain failure.
export const ConnectorErrorResponseSchema = z.object({ error: z.string().min(1) })
