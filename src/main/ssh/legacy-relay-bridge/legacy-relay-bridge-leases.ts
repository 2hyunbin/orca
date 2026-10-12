/**
 * Which relay-era leases the bridge may serve.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

/**
 * One a relay-era pane still names and nobody closed: a lease with a stop still pending, or one a
 * newer pane won, was meant to go away and is never brought back.
 */
export function isBridgeableLease(lease: SshRemotePtyLease): boolean {
  return (
    lease.state !== 'terminated' &&
    typeof lease.tabId === 'string' &&
    lease.tabId.length > 0 &&
    !lease.pendingKill &&
    !lease.supersededBy &&
    !lease.relayIdRecycled
  )
}

export function bridgeableLeasesByRelayId(
  leases: readonly SshRemotePtyLease[]
): Map<string, SshRemotePtyLease> {
  return new Map(leases.filter(isBridgeableLease).map((lease) => [lease.ptyId, lease]))
}
