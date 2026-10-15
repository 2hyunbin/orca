import { getNotificationHiddenWorkspaceIds } from '@/attention/hidden-workspace-notification-mute'
import type { AppState } from '@/store/types'

let cached: { ids: ReadonlySet<string>; keys: readonly string[] } | null = null

/** The notification-hidden set as the sorted list the window graph publishes. */
export function getNotificationHiddenWorkspaceKeysFromState(state: AppState): readonly string[] {
  const ids = getNotificationHiddenWorkspaceIds(state)
  if (cached?.ids === ids) {
    return cached.keys
  }
  const keys = [...ids].sort()
  cached = { ids, keys }
  return keys
}

export function sameNotificationHiddenWorkspaceKeys(
  a: readonly string[] | null,
  b: readonly string[] | null
): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.length === b.length && a.every((key, i) => key === b[i]))
  )
}
