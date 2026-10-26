import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  CONNECTOR_LIMITS
} from '@orca-cloud/connector-contract'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { HostChallengeStore, HostSessionStore, hostSessionLockKey } from '@orca-cloud/host-handshake'
import { PUSH_LIMITS, type HostProofDomains } from '@orca-cloud/push-contract'

export const CONNECTOR_HOST_PROOF_DOMAINS: HostProofDomains = Object.freeze({
  transcript: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  challengePlaintext: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
})

const SESSION_LOCK_SCOPE = 'orca-connector-session'

// Every change to a host's link takes this lock, the same one session creation checks the link under.
export async function lockConnectorHost(transaction: CloudDatabase, hostId: string): Promise<void> {
  await transaction.lockQuotaScope(hostSessionLockKey(SESSION_LOCK_SCOPE, hostId))
}

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
        lockScope: SESSION_LOCK_SCOPE,
        ttlMs: CONNECTOR_LIMITS.sessionTtlMs,
        linkTable: 'connector_hosts'
      },
      now
    )
  }
}
