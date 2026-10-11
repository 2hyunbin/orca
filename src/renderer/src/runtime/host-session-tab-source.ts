import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  hostSnapshotAffirmsAgentSessions,
  hostSnapshotAffirmsClientHostedPages,
  hostSnapshotAffirmsWorktreeContents
} from './host-session-snapshot-authority'
import {
  sameSessionTabsPublicationLineage,
  isCurrentSessionTabsRuntimeFrame
} from './web-session-tabs-sync/publisher-identity-fences'
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

export function mergeHostSessionTabSource(
  previous: RuntimeMobileSessionTabsResult | undefined,
  incoming: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  if (
    !previous ||
    !sameSessionTabsPublicationLineage(previous.publicationEpoch, incoming.publicationEpoch)
  ) {
    return incoming
  }
  const named = new Set(incoming.tabs.map((tab) => tab.id))
  const carried = previous.tabs.filter(
    (tab) =>
      !named.has(tab.id) &&
      ((tab.type === 'agent-session' && !hostSnapshotAffirmsAgentSessions(incoming)) ||
        (tab.type === 'browser' &&
          tab.placement?.kind === 'client' &&
          !hostSnapshotAffirmsClientHostedPages(incoming)))
  )
  if (carried.length === 0) {
    return incoming
  }
  const carriedIds = new Set(carried.map((tab) => tab.id))
  const groups =
    incoming.tabGroups?.map((group) => ({ ...group, tabOrder: [...group.tabOrder] })) ?? []
  for (const previousGroup of previous.tabGroups ?? []) {
    const order = previousGroup.tabOrder.filter((id) => carriedIds.has(id))
    if (order.length === 0) {
      continue
    }
    const group = groups.find((candidate) => candidate.id === previousGroup.id)
    if (group) {
      group.tabOrder.push(...order)
    } else {
      groups.push({ ...previousGroup, tabOrder: order, activeTabId: null })
    }
  }
  return { ...incoming, tabs: [...incoming.tabs, ...carried], tabGroups: groups }
}

export function hostSessionTabSourceConfirmsOmission(
  incoming: RuntimeMobileSessionTabsResult,
  previous: RuntimeMobileSessionTabsResult | undefined,
  closedId: string
): boolean {
  if (!hostSnapshotAffirmsWorktreeContents(incoming)) {
    return false
  }
  const tab = previous?.tabs.find((candidate) => candidate.id === closedId)
  if (tab?.type === 'agent-session' || closedId.startsWith('agent-session:')) {
    return hostSnapshotAffirmsAgentSessions(incoming)
  }
  return (
    tab?.type !== 'browser' ||
    tab.placement?.kind !== 'client' ||
    hostSnapshotAffirmsClientHostedPages(incoming)
  )
}
