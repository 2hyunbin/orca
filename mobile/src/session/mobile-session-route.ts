import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

export type MobileSessionRouteParams = {
  hostId: string
  worktreeId: string
  paneKey?: string
  name?: string
}

export function mobileSessionRouteIdentity(hostId: string, worktreeId: string): string {
  return JSON.stringify([hostId, worktreeId])
}

/** Identities stay raw — the navigator owns the params, so pre-encoding a
 *  workspace id would reach the session screen still escaped. */
export function mobileSessionRouteTarget({
  hostId,
  worktreeId,
  name,
  paneKey
}: MobileSessionRouteParams): HostStackRouteTarget {
  return {
    name: '[hostId]/session/[worktreeId]',
    params: { hostId, worktreeId, ...(name ? { name } : {}), ...(paneKey ? { paneKey } : {}) }
  }
}
