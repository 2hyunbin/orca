import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import {
  movePaneKeyedRecord,
  removePaneKeys,
  removePaneKeysByTabPrefix
} from '../agent-status-pane-keyed-records'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'

// Marker transitions that ride inside another slice's `set()`: tab activation and subject
// removal. Each is pure and returns only the marker records, keeping today's reference rules.
// Removal never touches the workspace flag.

type MarkerRecord = Record<string, StoredAgentAttentionUnread>
type Markers = Pick<
  AppState,
  'unreadTerminalTabs' | 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'
>

/** Tab activation inside the active workspace reads the tab marker only; same reference if none. */
export function readTerminalTabsOnActivation(
  unreadTerminalTabs: MarkerRecord,
  terminalTabIds: Iterable<string>
): MarkerRecord {
  let next: MarkerRecord | null = null
  for (const tabId of terminalTabIds) {
    if (!unreadTerminalTabs[tabId]) {
      continue
    }
    next ??= { ...unreadTerminalTabs }
    delete next[tabId]
  }
  return next ?? unreadTerminalTabs
}

/** A closed terminal tab drops all three layers; only changed records are returned. */
export function removeClosedTerminalTabAttention(s: Markers, tabId: string): Partial<Markers> {
  const unreadTerminalTabs = omitRecordKeys(s.unreadTerminalTabs, [tabId])
  const unreadTerminalPanes = removePaneKeysByTabPrefix(s.unreadTerminalPanes, tabId)
  const unreadAgentCompletionPanes = removePaneKeysByTabPrefix(s.unreadAgentCompletionPanes, tabId)
  return {
    ...(unreadTerminalTabs !== s.unreadTerminalTabs ? { unreadTerminalTabs } : {}),
    ...(unreadTerminalPanes !== s.unreadTerminalPanes ? { unreadTerminalPanes } : {}),
    ...(unreadAgentCompletionPanes !== s.unreadAgentCompletionPanes
      ? { unreadAgentCompletionPanes }
      : {})
  }
}

/**
 * Terminal tab ids dropped by reconciliation, a mirrored host removal, or a unified close whose
 * terminal retirement runs elsewhere. Only the tab marker goes. `writable` lets a batched caller
 * hand back a record it already owns instead of a fresh copy.
 */
export function removeTerminalTabMarkers(
  unreadTerminalTabs: MarkerRecord,
  tabIds: Iterable<string>,
  writable: (record: MarkerRecord) => MarkerRecord = (record) => ({ ...record })
): MarkerRecord {
  let next = unreadTerminalTabs
  for (const tabId of tabIds) {
    if (!next[tabId]) {
      continue
    }
    if (next === unreadTerminalTabs) {
      next = writable(unreadTerminalTabs)
    }
    delete next[tabId]
  }
  return next
}

/** Sleep and shutdown: every layer of the given tabs; unchanged records keep their reference. */
export function removeShutdownTabsAttention(s: Markers, tabIds: readonly string[]): Markers {
  const tabIdSet = new Set(tabIds)
  const ownedByShutdownTab = (paneKey: string): boolean => {
    for (const tabId of tabIdSet) {
      if (paneKey.startsWith(`${tabId}:`)) {
        return true
      }
    }
    return false
  }
  return {
    unreadTerminalTabs: omitRecordKeys(s.unreadTerminalTabs, tabIds),
    unreadTerminalPanes: removePaneKeys(
      s.unreadTerminalPanes,
      new Set(Object.keys(s.unreadTerminalPanes).filter(ownedByShutdownTab))
    ),
    unreadAgentCompletionPanes: removePaneKeys(
      s.unreadAgentCompletionPanes,
      new Set(Object.keys(s.unreadAgentCompletionPanes).filter(ownedByShutdownTab))
    )
  }
}

/** A hibernated pane drops its pane and completion layers; the tab marker stays. */
export function removeHibernatedPaneAttention(
  s: Markers,
  paneKey: string
): Pick<Markers, 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'> {
  const unreadTerminalPanes = { ...s.unreadTerminalPanes }
  const unreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
  delete unreadTerminalPanes[paneKey]
  delete unreadAgentCompletionPanes[paneKey]
  return { unreadTerminalPanes, unreadAgentCompletionPanes }
}

/** A retired pane authority drops its pane and completion layers. */
export function removeRetiredPaneAttention(
  s: Markers,
  paneKeys: ReadonlySet<string>
): Pick<Markers, 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'> {
  return {
    unreadTerminalPanes: removePaneKeys(s.unreadTerminalPanes, paneKeys),
    unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, paneKeys)
  }
}

/** A recorded provider session replaces the turn, so only its completion marker goes. */
export function removeSupersededCompletionAttention(
  s: Markers,
  paneKeys: ReadonlySet<string>
): Pick<Markers, 'unreadAgentCompletionPanes'> {
  return { unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, paneKeys) }
}

/** Acknowledged agents drop their completion markers; null when none was set. */
export function removeAcknowledgedCompletionAttention(
  unreadAgentCompletionPanes: MarkerRecord,
  paneKeys: readonly string[]
): MarkerRecord | null {
  let next: MarkerRecord | null = null
  for (const key of paneKeys) {
    if (unreadAgentCompletionPanes[key]) {
      next ??= { ...unreadAgentCompletionPanes }
      delete next[key]
    }
  }
  return next
}

/** A pane authority moving to a new key carries its pane and completion layers along. */
export function movePaneAttention(
  s: Markers,
  fromPaneKey: string,
  toPaneKey: string
): Pick<Markers, 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'> {
  return {
    unreadTerminalPanes: movePaneKeyedRecord(s.unreadTerminalPanes, fromPaneKey, toPaneKey),
    unreadAgentCompletionPanes: movePaneKeyedRecord(
      s.unreadAgentCompletionPanes,
      fromPaneKey,
      toPaneKey
    )
  }
}

/** Purged workspaces drop every layer of their tabs. */
export function removePurgedTabsAttention(s: Markers, doomedTabIds: ReadonlySet<string>): Markers {
  // Pane keys are `${tabId}:${leafId}`; tabId never contains ":", so the prefix is the owning tab.
  const omitPanesOfDoomedTabs = (record: MarkerRecord): MarkerRecord => {
    // Null-tolerant: some worktree-isolation callers omit these slices (production always inits to {}).
    if (!record) {
      return record
    }
    return omitRecordKeys(
      record,
      Object.keys(record).filter((paneKey) => {
        const sep = paneKey.indexOf(':')
        return sep > 0 && doomedTabIds.has(paneKey.slice(0, sep))
      })
    )
  }
  return {
    unreadTerminalTabs: omitRecordKeys(s.unreadTerminalTabs, doomedTabIds),
    unreadTerminalPanes: omitPanesOfDoomedTabs(s.unreadTerminalPanes),
    unreadAgentCompletionPanes: omitPanesOfDoomedTabs(s.unreadAgentCompletionPanes)
  }
}
