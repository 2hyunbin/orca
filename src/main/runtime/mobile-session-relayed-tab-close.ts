import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-types'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import {
  publishMobileSessionRetirement,
  retireMobileSessionTabFrom,
  type MobileSessionSnapshotPublisher
} from './mobile-session-tab-retirement'

export type RelayedMobileSessionTabCloseHost = MobileSessionSnapshotPublisher & {
  notifier: Pick<RuntimeNotifier, 'closeSessionTab'> | null
}

/**
 * Asks the window to close a browser or editor tab it owns, then drops the tab from the host's list.
 * The relay rejects when the window declines or lacks the tab, so a refused close retires nothing.
 */
export async function closeRelayedMobileSessionTab(
  host: RelayedMobileSessionTabCloseHost,
  worktreeId: string,
  tab: RuntimeMobileSessionSnapshotTab
): Promise<void> {
  if (!host.notifier?.closeSessionTab) {
    throw new Error('runtime_unavailable')
  }
  await host.notifier.closeSessionTab(tab.id, worktreeId)
  const snapshot = host.mobileSessionTabsByWorktree.get(worktreeId)
  publishMobileSessionRetirement(
    host,
    worktreeId,
    snapshot ? retireMobileSessionTabFrom(snapshot, tab.id) : null
  )
}
