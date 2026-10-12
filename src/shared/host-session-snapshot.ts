import type { RuntimeMobileSessionTabsResult } from './runtime-types'
import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
} from './runtime-types'

type SnapshotPublication = {
  publicationEpoch: string
  snapshotVersion: number
}

type ClientHostedPagePublication = SnapshotPublication & {
  clientHostedPagesUnreconciled?: true
}

type AgentSessionPublication = SnapshotPublication & {
  agentSessionsUnverifiable?: true
}

/**
 * Whether a session-tabs snapshot carries the host's answer about a worktree at all.
 *
 * A runtime that has published nothing for a worktree still answers a forced snapshot, with a
 * synthesized empty frame. Every worktree is in that state for a moment after the host process
 * restarts, and the frame is indistinguishable from "the user closed everything" unless the epoch
 * is read: `UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH`, bare or with a paired client's navigation
 * suffix, is the runtime saying "ask me later". Absence in such a frame proves nothing, so it must not drive a cull.
 *
 * Deliberately not part of the staleness gate: the frame is not stale, and rejecting it outright
 * would also drop the terminal reconciliation that legitimately rides on it.
 */
export function hostSnapshotAffirmsWorktreeContents(snapshot: SnapshotPublication): boolean {
  return (
    snapshot.publicationEpoch !== UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH &&
    snapshot.publicationEpoch !==
      `${UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH}${CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX}`
  )
}

/**
 * Whether a snapshot's browser rows are the host's answer about this desktop's client-hosted pages.
 *
 * Narrower than {@link hostSnapshotAffirmsWorktreeContents} on purpose. A restarted runtime rebuilds
 * terminals from disk and publishes a real, versioned frame under a real epoch — authoritative for
 * everything it owns, but silently missing the client-hosted pages it has not yet taken back from
 * the hosts still holding them. `clientHostedPagesUnreconciled` is the host saying so, and the
 * runtime bounds it, so trusting it cannot strand a row indefinitely.
 */
export function hostSnapshotAffirmsClientHostedPages(
  snapshot: ClientHostedPagePublication
): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.clientHostedPagesUnreconciled
}

/**
 * Whether a snapshot's `agent-session` rows are the host's answer about which chats exist.
 *
 * Narrower than {@link hostSnapshotAffirmsWorktreeContents} for the same reason as client-hosted
 * pages: a runtime whose chat journal will not open is authoritative about terminals but cannot
 * list a single chat. Its empty chat set is "cannot tell", and culling on it would delete tabs
 * whose chats are safe on disk.
 */
export function hostSnapshotAffirmsAgentSessions(snapshot: AgentSessionPublication): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.agentSessionsUnverifiable
}

/**
 * A headless merge keeps the renderer publication as its base epoch while
 * adding runtime-owned surfaces. Treat both forms as one ordering lineage.
 */
export function sameSessionTabsPublicationLineage(left: string, right: string): boolean {
  return (
    left === right ||
    ((left.includes(':headless-merge:') || right.includes(':headless-merge:')) &&
      left.split(':headless-merge:')[0] === right.split(':headless-merge:')[0])
  )
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

/** Cached host content has no authority to select a tab or request navigation. */
export function projectHostSessionTabSource(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  return {
    ...snapshot,
    activeTabId: null,
    activeTabType: null,
    activeGroupId: null,
    navigationIntent: undefined,
    tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: false }))
  }
}
