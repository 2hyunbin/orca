import { getNotificationHiddenWorkspaceIds } from '@/attention/hidden-workspace-notification-mute'
import type { AppState } from '@/store/types'
import { graphState } from './graph-state'

/** The hidden set when its contents differ from the copy main last accepted; else null. */
export function changedNotificationHiddenWorkspaces(state: AppState): Set<string> | null {
  const hidden = getNotificationHiddenWorkspaceIds(state)
  const published = graphState.publishedNotificationHiddenWorkspaces
  if (
    hidden === null ||
    (published !== null &&
      published.size === hidden.size &&
      [...hidden].every((key) => published.has(key)))
  ) {
    return null
  }
  return hidden
}
