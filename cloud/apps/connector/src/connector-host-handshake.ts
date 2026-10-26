import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  CONNECTOR_LIMITS
} from '@orca-cloud/connector-contract'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { HostChallengeStore, HostSessionStore } from '@orca-cloud/host-handshake'
import { PUSH_LIMITS, type HostProofDomains } from '@orca-cloud/push-contract'

export const CONNECTOR_HOST_PROOF_DOMAINS: HostProofDomains = Object.freeze({
  transcript: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  challengePlaintext: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
})

// Push's handshake under the connector's domains; a session counts only while its host is linked.
export function createConnectorHandshake(
  database: CloudDatabase,
  publicUrl: string,
  now: () => number
): { challenges: HostChallengeStore; sessions: HostSessionStore } {
  return {
    challenges: new HostChallengeStore(
      database,
      {
        table: 'connector_challenges',
        gatewayOrigin: publicUrl,
        proofDomains: CONNECTOR_HOST_PROOF_DOMAINS,
        ttlMs: PUSH_LIMITS.challengeTtlMs,
        clockSkewToleranceMs: PUSH_LIMITS.clockSkewToleranceMs
      },
      now
    ),
    sessions: new HostSessionStore(
      database,
      {
        table: 'connector_sessions',
        lockScope: 'orca-connector-session',
        ttlMs: CONNECTOR_LIMITS.sessionTtlMs,
        linkTable: 'connector_hosts'
      },
      now
    )
  }
}
