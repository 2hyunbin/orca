import type { MobilePushFilter } from '../../../src/shared/mobile-push-contract'
import { NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  loadRemotePushHostRegistrations,
  saveRemotePushHostRegistrations
} from '../storage/preferences'

export type RegistrationRecords = {
  registered: Set<string>
  pending: Set<string>
  capable: Set<string>
}
export type RegisteringHost = { announcesAgentAlerts: boolean }
let registrationRecords: RegistrationRecords | null = null

export async function readRecords(): Promise<RegistrationRecords> {
  if (!registrationRecords) {
    const stored = await loadRemotePushHostRegistrations()
    registrationRecords ??= {
      registered: new Set(stored.registeredHostIds),
      pending: new Set(stored.pendingUnregisterHostIds),
      capable: new Set(stored.sourceAlertHostIds ?? [])
    }
  }
  return registrationRecords
}

export async function mutateRecords(
  mutate: (value: RegistrationRecords) => void,
  onCapabilityChange?: () => void
): Promise<void> {
  const value = await readRecords()
  const signature = () => JSON.stringify([[...value.registered].sort(), [...value.capable].sort()])
  const before = signature()
  mutate(value)
  await saveRemotePushHostRegistrations({
    registeredHostIds: [...value.registered],
    pendingUnregisterHostIds: [...value.pending],
    ...(value.capable.size ? { sourceAlertHostIds: [...value.capable] } : {})
  })
  if (signature() !== before) {
    onCapabilityChange?.()
  }
}

export function forgetHost(records: RegistrationRecords, hostId: string): void {
  records.registered.delete(hostId)
  records.pending.delete(hostId)
  records.capable.delete(hostId)
}
export function hostAnnouncesAgentAlerts(capabilities: readonly string[]): boolean {
  return capabilities.includes(NOTIFICATIONS_HOST_AGENT_ALERTS_RUNTIME_CAPABILITY)
}
export function registrationFilter(
  records: RegistrationRecords,
  hostId: string,
  host: RegisteringHost,
  preferences: MobilePushFilter
): MobilePushFilter {
  return {
    ...preferences,
    ...(host.announcesAgentAlerts
      ? {
          sourceAgentAlerts: true,
          hostAgentAlerts: [...records.registered].every(
            (other) => other === hostId || records.capable.has(other)
          )
        }
      : {})
  }
}
export function recordRegistered(
  records: RegistrationRecords,
  hostId: string,
  host: RegisteringHost
): void {
  records.registered.add(hostId)
  if (host.announcesAgentAlerts) {
    records.capable.add(hostId)
  } else {
    records.capable.delete(hostId)
  }
}
export function resetRegistrationRecordsForTests(): void {
  registrationRecords = null
}
