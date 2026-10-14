import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../../shared/tab-types'

// Which markers still count for a workspace: only those on a tab it still owns, so a marker
// orphaned by a closed tab or a superseded session can neither light nor hold its dot.

type MarkerRecord = Readonly<Record<string, StoredAgentAttentionUnread>>

export type LiveMarkerSources = {
  tabsByWorktree?: Readonly<Record<string, readonly Pick<TerminalTab, 'id'>[]>>
  unifiedTabsByWorktree?: Readonly<Record<string, readonly Pick<Tab, 'id' | 'contentType'>[]>>
  unreadTerminalTabs?: MarkerRecord
}

/** A tab marker on a live terminal or structured chat tab — the Dock's folder rule. */
export function hasLiveTabMarker(sources: LiveMarkerSources, workspaceId: string): boolean {
  return Boolean(
    sources.tabsByWorktree?.[workspaceId]?.some((tab) => sources.unreadTerminalTabs?.[tab.id]) ||
    sources.unifiedTabsByWorktree?.[workspaceId]?.some(
      (tab) => tab.contentType === 'agent-session' && sources.unreadTerminalTabs?.[tab.id]
    )
  )
}

/** Tab ids that can own a marker in a workspace: terminal tabs and structured chat tabs. */
export function workspaceMarkerTabIds(
  sources: LiveMarkerSources,
  workspaceId: string
): Set<string> {
  const tabIds = new Set<string>()
  for (const tab of sources.tabsByWorktree?.[workspaceId] ?? []) {
    tabIds.add(tab.id)
  }
  for (const tab of sources.unifiedTabsByWorktree?.[workspaceId] ?? []) {
    if (tab.contentType === 'agent-session') {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}

/** Pane keys are `${tabId}:${leafId}` and tab ids never contain ":". */
export function paneKeyTabId(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  return separator > 0 ? paneKey.slice(0, separator) : null
}

/** What the workspace flag follows: a tab or completion marker on a live tab. */
export function workspaceHasLiveMarker(
  sources: Omit<LiveMarkerSources, 'unifiedTabsByWorktree'> & {
    unifiedTabsByWorktree?: Readonly<
      Record<string, readonly Pick<Tab, 'id' | 'contentType' | 'entityId'>[]>
    >
    unreadAgentCompletionPanes: MarkerRecord
  },
  workspaceId: string
): boolean {
  if (hasLiveTabMarker(sources, workspaceId)) {
    return true
  }
  const completionKeys = Object.keys(sources.unreadAgentCompletionPanes)
  if (completionKeys.length === 0) {
    return false
  }
  const terminalTabIds = new Set((sources.tabsByWorktree?.[workspaceId] ?? []).map((tab) => tab.id))
  if (
    completionKeys.some((paneKey) => {
      const tabId = paneKeyTabId(paneKey)
      return tabId !== null && terminalTabIds.has(tabId)
    })
  ) {
    return true
  }
  // Why the current session's key only: a tab rebound to a new session no longer owns the old one.
  return (sources.unifiedTabsByWorktree?.[workspaceId] ?? []).some(
    (tab) =>
      tab.contentType === 'agent-session' &&
      Boolean(
        sources.unreadAgentCompletionPanes[structuredAgentSessionPaneKey(tab.id, tab.entityId)]
      )
  )
}
