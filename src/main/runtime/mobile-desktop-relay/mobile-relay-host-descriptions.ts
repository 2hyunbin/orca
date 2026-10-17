import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import { pickerExecutionHosts } from '../../../shared/managed-orcad-execution-host'
import type {
  MobileRelayHost,
  MobileRelayHostRelay
} from '../../../shared/mobile-relay-hosts-contract'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHosts
} from './mobile-desktop-relay-hosts'

export type DescribedRelayHost = MobileRelayHost & {
  environmentId: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

/** The configured servers the desktop shows, with health from its own status (the sidebar's mapping). */
export function describeRelayHosts(
  hosts: Pick<MobileDesktopRelayHosts, 'list'>,
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string> = new Map()
): DescribedRelayHost[] {
  const { environments, statusByEnvironmentId, sshTargetLabels, sshConnectionStates } = hosts.list()
  const identities = new Map(environments.map((environment) => [environment.id, environment]))
  // Why the desktop's picker rows: a managed server folds into its SSH host as the sidebar shows it.
  return pickerExecutionHosts(
    buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments: environments,
      runtimeStatusByEnvironmentId: statusByEnvironmentId,
      hostLabelOverrides
    })
  ).flatMap((entry) => {
    const parsed = parseExecutionHostId(entry.id)
    const identity = parsed?.kind === 'runtime' ? identities.get(parsed.environmentId) : undefined
    if (parsed?.kind !== 'runtime' || !identity) {
      return []
    }
    const answer = lastVerifiedRuntimeStatus(statusByEnvironmentId.get(parsed.environmentId))
    return [
      {
        hostId: parsed.id,
        environmentId: parsed.environmentId,
        identity: { pairingRevision: identity.pairingRevision, runtimeId: identity.runtimeId },
        label: entry.label,
        health: entry.health,
        relay: relayVerdict(entry.health, answer)
      }
    ]
  })
}

export function relayHostFence(identity: DescribedRelayHost['identity']): string {
  return `${identity.pairingRevision}\0${identity.runtimeId}`
}

function relayVerdict(
  health: MobileRelayHost['health'],
  answer: RuntimeStatus | null
): MobileRelayHostRelay {
  if (!answer) {
    return 'unavailable'
  }
  // Why: a build's capabilities do not expire, so an old server stays update-needed while offline.
  if (!(answer.capabilities ?? []).includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return 'update-needed'
  }
  return health === 'available' ? 'ready' : 'unavailable'
}
