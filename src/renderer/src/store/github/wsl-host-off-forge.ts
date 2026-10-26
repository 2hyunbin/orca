/**
 * E9: forge (PR/review) refreshes for a workspace on a WSL host go through the host, which never
 * boots a stopped distro for a poll. Skip them while the host isn't ready and say so, rather than
 * failing a request per badge.
 */
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AppState } from '../types'
import type { PRRefreshState } from './pr-refresh-state'

export function isWslHostOffForForge(
  // Partial: narrowed store snapshots may omit either slice.
  state: Partial<Pick<AppState, 'runtimeEnvironments' | 'wslHostStatuses'>>,
  environmentId: string
): boolean {
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return Boolean(
    environment &&
    isWslHostRuntimeEnvironment(environment) &&
    state.wslHostStatuses?.[environmentId]?.state !== 'ready'
  )
}

/** Records the skip, so the Checks panel says the host is off instead of showing stale status. */
export function withForgeHostOffSkip(
  states: Record<string, PRRefreshState>,
  cacheKey: string
): { prRefreshStates: Record<string, PRRefreshState> } {
  return {
    prRefreshStates: {
      ...states,
      [cacheKey]: {
        status: 'skipped',
        reason: 'swr',
        skippedReason: 'host-off',
        updatedAt: Date.now()
      }
    }
  }
}
