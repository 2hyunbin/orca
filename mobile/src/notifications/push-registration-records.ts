// The phone's record of the hosts it registered for push with (persisted, so a restart still retries
// an unregister), and which of them push this phone their own agents' alerts. Each host's filter is
// derived from it on every registration, so no host is told a stale claim for longer than one renewal.
import {
  MOBILE_PUSH_LEASE_MS,
  type DirectAgentAlertHost,
  type MobilePushFilter
} from '../../../src/shared/mobile-push-contract'
import { NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  loadRemotePushHostRegistrations,
  saveRemotePushHostRegistrations,
  type DirectAlertHostRecord
} from '../storage/preferences'

// Stop vouching for a host a day before its lease on this phone can lapse, so clock skew between
// this phone and a forwarding desktop never leaves a gap where neither pushes.
const DIRECT_ALERT_CLAIM_MARGIN_MS = 24 * 60 * 60_000

export type RegistrationRecords = {
  registered: Set<string>
  pending: Set<string>
  direct: Map<string, DirectAlertHostRecord>
}

export type RegisteringHost = { announcesAgentAlerts: boolean; fingerprint: string | null }

let registrationRecords: RegistrationRecords | null = null

export async function readRecords(): Promise<RegistrationRecords> {
  if (!registrationRecords) {
    const stored = await loadRemotePushHostRegistrations()
    registrationRecords ??= {
      registered: new Set(stored.registeredHostIds),
      pending: new Set(stored.pendingUnregisterHostIds),
      direct: new Map(Object.entries(stored.directAlertHosts ?? {}))
    }
  }
  return registrationRecords
}

/** `onDirectAlertChange` runs when other hosts' filters would now differ. */
export async function mutateRecords(
  mutate: (value: RegistrationRecords) => void,
  onDirectAlertChange?: () => void
): Promise<void> {
  const value = await readRecords()
  const before = directAlertSignature(value)
  mutate(value)
  await saveRemotePushHostRegistrations({
    registeredHostIds: [...value.registered],
    pendingUnregisterHostIds: [...value.pending],
    ...(value.direct.size > 0 ? { directAlertHosts: Object.fromEntries(value.direct) } : {})
  })
  if (onDirectAlertChange && directAlertSignature(value) !== before) {
    onDirectAlertChange()
  }
}

export function forgetHost(records: RegistrationRecords, hostId: string): void {
  records.registered.delete(hostId)
  records.pending.delete(hostId)
  records.direct.delete(hostId)
}

export function hostAnnouncesAgentAlerts(capabilities: readonly string[]): boolean {
  return capabilities.includes(NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY)
}

/**
 * The phone takes a host's own agent alerts only when no other host it registered with would still
 * forward them, and only from a host the others can name. It lists the hosts it took them from.
 */
export function registrationFilter(
  records: RegistrationRecords,
  hostId: string,
  host: RegisteringHost,
  preferences: MobilePushFilter
): { filter: MobilePushFilter; optedIn: boolean } {
  const optedIn =
    host.announcesAgentAlerts &&
    host.fingerprint !== null &&
    [...records.registered].every((other) => other === hostId || records.direct.has(other))
  const directAgentAlertHosts = directAgentAlertHostsFor(records, hostId, host.fingerprint)
  return {
    optedIn,
    filter: {
      ...preferences,
      ...(optedIn ? { hostAgentAlerts: true } : {}),
      ...(directAgentAlertHosts.length > 0 ? { directAgentAlertHosts } : {})
    }
  }
}

export function recordRegistered(
  records: RegistrationRecords,
  hostId: string,
  host: RegisteringHost,
  optedIn: boolean
): void {
  records.registered.add(hostId)
  if (host.announcesAgentAlerts && host.fingerprint) {
    records.direct.set(hostId, { fingerprint: host.fingerprint, registeredAt: Date.now(), optedIn })
  } else {
    records.direct.delete(hostId)
  }
}

function directAgentAlertHostsFor(
  records: RegistrationRecords,
  hostId: string,
  hostFingerprint: string | null
): DirectAgentAlertHost[] {
  const now = Date.now()
  const hosts: DirectAgentAlertHost[] = []
  for (const [otherHostId, record] of records.direct) {
    const until = record.registeredAt + MOBILE_PUSH_LEASE_MS - DIRECT_ALERT_CLAIM_MARGIN_MS
    if (
      record.optedIn &&
      otherHostId !== hostId &&
      record.fingerprint !== hostFingerprint &&
      until > now
    ) {
      hosts.push({ fingerprint: record.fingerprint, until })
    }
  }
  return hosts
}

/** What other hosts' filters derive from; `registeredAt` is left out so renewals don't cascade. */
function directAlertSignature(records: RegistrationRecords): string {
  const hostIds = [...new Set([...records.registered, ...records.direct.keys()])].sort()
  return JSON.stringify(
    hostIds.map((id) => [id, records.direct.get(id)?.fingerprint, records.direct.get(id)?.optedIn])
  )
}

export function resetRegistrationRecordsForTests(): void {
  registrationRecords = null
}
