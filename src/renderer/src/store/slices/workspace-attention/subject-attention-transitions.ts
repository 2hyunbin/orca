import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import { movePaneKeyedRecord, removePaneKeys } from '../agent-status-pane-keyed-records'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { paneKeyTabId } from './workspace-live-markers'

// Marker removals that ride inside another slice's `set()`. Unchanged records keep their
// reference. Removal never touches the workspace flag.

type MarkerRecord = Record<string, StoredAgentAttentionUnread>
type Markers = Pick<
  AppState,
  'unreadTerminalTabs' | 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'
>
type PaneMarkers = Pick<Markers, 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'>

function paneKeysOfTabs(record: MarkerRecord, tabIds: ReadonlySet<string>): Set<string> {
  return new Set(
    Object.keys(record).filter((paneKey) => {
      const tabId = paneKeyTabId(paneKey)
      return tabId !== null && tabIds.has(tabId)
    })
  )
}

/** Closed, slept or purged tabs drop every layer. */
export function removeTabsAttention(s: Markers, tabIds: Iterable<string>): Markers {
  const removed = new Set(tabIds)
  return {
    unreadTerminalTabs: omitRecordKeys(s.unreadTerminalTabs, removed),
    unreadTerminalPanes: removePaneKeys(
      s.unreadTerminalPanes,
      paneKeysOfTabs(s.unreadTerminalPanes, removed)
    ),
    unreadAgentCompletionPanes: removePaneKeys(
      s.unreadAgentCompletionPanes,
      paneKeysOfTabs(s.unreadAgentCompletionPanes, removed)
    )
  }
}

/** Hibernated or retired panes drop their pane and completion layers; the tab marker stays. */
export function removePanesAttention(s: Markers, paneKeys: ReadonlySet<string>): PaneMarkers {
  return {
    unreadTerminalPanes: removePaneKeys(s.unreadTerminalPanes, paneKeys),
    unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, paneKeys)
  }
}

/** A superseded or acknowledged turn drops only its completion marker. */
export function removeCompletionAttention(
  unreadAgentCompletionPanes: MarkerRecord,
  paneKeys: Iterable<string>
): MarkerRecord {
  return removePaneKeys(unreadAgentCompletionPanes, new Set(paneKeys))
}

/** Tab markers only, for terminals retired elsewhere; `copyOnWrite` returns the record to drain. */
export function removeTabMarkers(
  unreadTerminalTabs: MarkerRecord,
  tabIds: Iterable<string>,
  copyOnWrite: (record: MarkerRecord) => MarkerRecord
): MarkerRecord {
  let next = unreadTerminalTabs
  for (const tabId of tabIds) {
    if (!next[tabId]) {
      continue
    }
    if (next === unreadTerminalTabs) {
      next = copyOnWrite(unreadTerminalTabs)
    }
    delete next[tabId]
  }
  return next
}

/** A pane authority moving to a new key carries its pane and completion layers along. */
export function movePaneAttention(s: Markers, fromPaneKey: string, toPaneKey: string): PaneMarkers {
  return {
    unreadTerminalPanes: movePaneKeyedRecord(s.unreadTerminalPanes, fromPaneKey, toPaneKey),
    unreadAgentCompletionPanes: movePaneKeyedRecord(
      s.unreadAgentCompletionPanes,
      fromPaneKey,
      toPaneKey
    )
  }
}
