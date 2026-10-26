import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { HostChallengeStore } from '@orca-cloud/host-handshake'
import { PUSH_HOST_PROOF_DOMAINS, PUSH_LIMITS } from '@orca-cloud/push-contract'

export class PushHostChallengeStore extends HostChallengeStore {
  constructor(database: CloudDatabase, gatewayOrigin: string, now?: () => number) {
    super(
      database,
      {
        table: 'push_challenges',
        gatewayOrigin,
        proofDomains: PUSH_HOST_PROOF_DOMAINS,
        ttlMs: PUSH_LIMITS.challengeTtlMs,
        clockSkewToleranceMs: PUSH_LIMITS.clockSkewToleranceMs
      },
      now
    )
  }
}
