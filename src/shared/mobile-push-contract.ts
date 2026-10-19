// Why: the desktop host, the push gateway, and the phone must agree on these
// exact strings. See cloud/packages/push-contract/src.

export const MOBILE_PUSH_SOURCES = ['agent-task-complete', 'terminal-bell', 'plugin'] as const
export type MobilePushSource = (typeof MOBILE_PUSH_SOURCES)[number]

// The only two states a phone can be told about; the host maps its richer
// agent status onto them before it ever reaches the gateway.
export const MOBILE_PUSH_AGENT_STATES = ['needs-input', 'finished'] as const
export type MobilePushAgentState = (typeof MOBILE_PUSH_AGENT_STATES)[number]

export const MOBILE_PUSH_PLATFORMS = ['ios', 'android'] as const
export type MobilePushPlatform = (typeof MOBILE_PUSH_PLATFORMS)[number]

export const MOBILE_PUSH_APNS_ENVIRONMENTS = ['sandbox', 'production'] as const
export type MobilePushApnsEnvironment = (typeof MOBILE_PUSH_APNS_ENVIRONMENTS)[number]

/** A host keeps a phone's push registration this long after the phone last renewed it. */
export const MOBILE_PUSH_LEASE_MS = 7 * 24 * 60 * 60_000

/** Another host that pushes this phone its own agent alerts, until `until` (epoch ms). */
export type DirectAgentAlertHost = { fingerprint: string; until: number }

export type MobilePushFilter = {
  onlyWhenDesktopAway?: boolean
  sound?: boolean
  /** This phone takes the host's own agent alerts from main instead of its window's copies. Set only
   *  when no host it registered with would still forward them, so a mixed-version setup keeps today's path. */
  hostAgentAlerts?: boolean
  /** A forwarding desktop skips host-announced alerts from these hosts; the phone hears them directly. */
  directAgentAlertHosts?: DirectAgentAlertHost[]
}

/** Persisted on the paired DeviceEntry so a host restart can push without the phone re-registering. */
export type MobilePushRegistration = {
  registrationId: string
  filter: MobilePushFilter
  expiresAt: number
}

export type MobilePushRegisterInput = {
  deviceId: string
  platform: MobilePushPlatform
  token: string
  apnsEnvironment?: MobilePushApnsEnvironment
  filter: MobilePushFilter
}

export type MobilePushRegisterResult =
  | { registered: true; registrationId: string }
  | {
      registered: false
      // Storage failures require registration to be retried; throttling leaves the prior route intact.
      reason:
        | 'gateway_unreachable'
        | 'gateway_rejected'
        | 'not_mobile'
        | 'registration_storage_failed'
        | 'throttled'
    }

function parseFilter(value: unknown): MobilePushFilter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const filter = value as Partial<MobilePushFilter>
  if (
    (filter.onlyWhenDesktopAway !== undefined && typeof filter.onlyWhenDesktopAway !== 'boolean') ||
    (filter.sound !== undefined && typeof filter.sound !== 'boolean') ||
    (filter.hostAgentAlerts !== undefined && typeof filter.hostAgentAlerts !== 'boolean')
  ) {
    return null
  }
  const directAgentAlertHosts = parseDirectAgentAlertHosts(filter.directAgentAlertHosts)
  return {
    ...(typeof filter.onlyWhenDesktopAway === 'boolean'
      ? { onlyWhenDesktopAway: filter.onlyWhenDesktopAway }
      : {}),
    ...(typeof filter.sound === 'boolean' ? { sound: filter.sound } : {}),
    ...(filter.hostAgentAlerts === true ? { hostAgentAlerts: true } : {}),
    ...(directAgentAlertHosts.length > 0 ? { directAgentAlertHosts } : {})
  }
}

// A malformed entry only costs a duplicate alert, so it is dropped rather than failing the row.
function parseDirectAgentAlertHosts(value: unknown): DirectAgentAlertHost[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) =>
    entry &&
    typeof entry === 'object' &&
    'fingerprint' in entry &&
    'until' in entry &&
    typeof entry.fingerprint === 'string' &&
    entry.fingerprint.length > 0 &&
    typeof entry.until === 'number' &&
    Number.isFinite(entry.until)
      ? [{ fingerprint: entry.fingerprint, until: entry.until }]
      : []
  )
}

/**
 * Reads a persisted registration back. Returns undefined for invalid data,
 * so a bad row degrades to "this device has no push"
 * instead of failing the whole registry load.
 */
export function parseMobilePushRegistration(value: unknown): MobilePushRegistration | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const registration = value as Partial<MobilePushRegistration>
  const filter = parseFilter(registration.filter)
  if (
    typeof registration.registrationId !== 'string' ||
    registration.registrationId.length === 0 ||
    !filter ||
    typeof registration.expiresAt !== 'number' ||
    !Number.isFinite(registration.expiresAt)
  ) {
    return undefined
  }
  return {
    registrationId: registration.registrationId,
    filter,
    expiresAt: registration.expiresAt
  }
}

export type MobilePushTestResult =
  | { accepted: true }
  | { accepted: false; reason: 'not_registered' | 'unavailable' | 'rate_limited' | 'rejected' }
