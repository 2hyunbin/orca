import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  hostSnapshotAffirmsWorktreeContents,
  mergeHostSessionTabSource
} from '../../../shared/host-session-snapshot'
export {
  mergeHostSessionTabSource,
  hostSessionTabSourceConfirmsOmission
} from '../../../shared/host-session-snapshot'
import { isCurrentSessionTabsRuntimeFrame } from './web-session-tabs-sync/publisher-identity-fences'
import {
  latestSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree
} from './web-session-tabs-sync/state'
import { sessionTabsFreshnessKey } from './web-session-tabs-sync/tracking'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export function retainAcceptedHostSessionTabSource(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  pairingRevision: number | undefined
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const accepted = latestSessionTabsSnapshotByWorktree.get(key)
  if (
    !accepted ||
    accepted.publicationEpoch !== snapshot.publicationEpoch ||
    accepted.snapshotVersion !== snapshot.snapshotVersion ||
    !hostSnapshotAffirmsWorktreeContents(snapshot) ||
    !isCurrentSessionTabsRuntimeFrame(environmentId, accepted.runtimeId) ||
    getRuntimeEnvironmentRevision(environmentId) !== pairingRevision ||
    ('removed' in snapshot && snapshot.removed === true)
  ) {
    return
  }
  accepted.source = mergeHostSessionTabSource(accepted.source, snapshot)
  accepted.pairingRevision = pairingRevision
  accepted.sourceRuntimeId = accepted.runtimeId
  accepted.sourceReceivedFrame = latestReceivedSessionTabsSnapshotByWorktree.get(key)?.receivedFrame
}
