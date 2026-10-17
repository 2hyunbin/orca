// Chat (agent-session) tabs in a layout-owner build (E2-5). The window still draws a chat's tab
// first, from its own launch or from this machine's host listing the chat; main records each open,
// close and prop change under the window's ids, so a window save no longer teaches main a chat tab.
// Nothing to undo on any answer: the window's next save carries a change main could not take.

import type { Tab } from '../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { recordLayoutApply } from './layout-apply-send'
import { newGroupSplitOf } from './layout-owner-new-group-split'

type ChatTabState = Parameters<typeof recordLayoutApply>[0] &
  Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'>

/** A chat tab the window just drew, placed where the window drew it. */
export function recordOpenedAgentSessionTabInLayoutOwner(state: ChatTabState, tab: Tab): void {
  if (tab.contentType !== 'agent-session' || !tab.agentSessionAgent) {
    return
  }
  const order = state.groupsByWorktree[tab.worktreeId]?.find(
    (group) => group.id === tab.groupId
  )?.tabOrder
  const position = order?.indexOf(tab.id) ?? -1
  const afterTabId = position > 0 ? order?.[position - 1] : undefined
  recordLayoutApply(state, tab.worktreeId, {
    type: 'openAgentSessionTab',
    tabId: tab.id,
    sessionId: tab.entityId,
    agent: tab.agentSessionAgent,
    groupId: tab.groupId,
    ...(afterTabId ? { afterTabId } : position === 0 ? { index: 0 } : {}),
    createdAt: tab.createdAt,
    ...newGroupSplitOf(state, tab.worktreeId, tab.groupId, tab.id)
  })
  recordChatTabProps(state, tab, { color: null })
}

/** A chat tab the window just closed. */
export function recordClosedAgentSessionTabInLayoutOwner(
  state: ChatTabState,
  tab: Pick<Tab, 'id' | 'worktreeId' | 'contentType'>
): void {
  if (tab.contentType === 'agent-session') {
    recordLayoutApply(state, tab.worktreeId, { type: 'closeTabs', tabIds: [tab.id] })
  }
}

/** The chat tabs a host listing added to, removed from or restyled in these workspaces' tab bars. */
export function recordSyncedAgentSessionTabsInLayoutOwner(
  before: ChatTabState,
  after: ChatTabState,
  worktreeIds: Iterable<string>
): void {
  for (const worktreeId of new Set(worktreeIds)) {
    const was = chatTabsById(before, worktreeId)
    const now = chatTabsById(after, worktreeId)
    for (const [id, tab] of was) {
      if (!now.has(id)) {
        recordClosedAgentSessionTabInLayoutOwner(after, tab)
      }
    }
    for (const [id, tab] of now) {
      const old = was.get(id)
      if (!old) {
        recordOpenedAgentSessionTabInLayoutOwner(after, tab)
      } else if (old !== tab) {
        recordChatTabProps(after, tab, old)
      }
    }
  }
}

function chatTabsById(state: ChatTabState, worktreeId: string): Map<string, Tab> {
  return new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
      tab.contentType === 'agent-session' ? [[tab.id, tab] as const] : []
    )
  )
}

/** A host's color or pin for a chat; an open carries neither, and a new tab is unpinned in main. */
function recordChatTabProps(
  state: ChatTabState,
  tab: Tab,
  old: Pick<Tab, 'color'> & Partial<Pick<Tab, 'isPinned'>>
): void {
  const color = tab.color ?? null
  const props = {
    ...(color !== (old.color ?? null) ? { color } : {}),
    ...(tab.isPinned !== undefined && tab.isPinned !== old.isPinned
      ? { isPinned: tab.isPinned }
      : {})
  }
  if (Object.keys(props).length > 0) {
    recordLayoutApply(state, tab.worktreeId, { type: 'setTabProps', tabId: tab.id, ...props })
  }
}
