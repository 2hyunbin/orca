import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TelemetrySettings } from '../../../../shared/telemetry-settings-types'

export type WorkspaceDiscoveryArm = 'control' | 'treatment'
type DiscoverySurface = EventProps<'workspace_discovery_shown'>['surface']
type DiscoveryAction = EventProps<'workspace_discovery_action'>['action']

// Profiles are assigned at load, so an absent arm only means settings have not hydrated yet.
export function getWorkspaceDiscoveryArm(
  telemetry: TelemetrySettings | undefined
): WorkspaceDiscoveryArm | undefined {
  return (
    telemetry?.workspaceDiscoveryNewUserCohort ?? telemetry?.workspaceDiscoveryExistingUserCohort
  )
}

export function isWorkspaceDiscoveryTelemetryEnabled(
  telemetry: TelemetrySettings | undefined
): boolean {
  return telemetry?.optedIn === true && getWorkspaceDiscoveryArm(telemetry) !== undefined
}

export function capWorkspaceDiscoveryCount(count: number): number {
  return Math.min(count, 50)
}

// Virtualized rows remount on scroll; keep each surface/action to one event per window session.
const observedThisSession = new Set<string>()

function observeOnce(key: string): boolean {
  if (observedThisSession.has(key)) {
    return false
  }
  observedThisSession.add(key)
  return true
}

export function trackWorkspaceDiscoveryShown(surface: DiscoverySurface, count: number): void {
  if (observeOnce(`shown:${surface}`)) {
    track('workspace_discovery_shown', {
      surface,
      workspace_count: capWorkspaceDiscoveryCount(count)
    })
  }
}

export function trackWorkspaceDiscoveryAction(
  surface: DiscoverySurface,
  action: DiscoveryAction,
  count: number
): void {
  if (observeOnce(`action:${surface}:${action}`)) {
    track('workspace_discovery_action', {
      surface,
      action,
      workspace_count: capWorkspaceDiscoveryCount(count)
    })
  }
}

export function resetWorkspaceDiscoveryObservationsForTests(): void {
  observedThisSession.clear()
}
