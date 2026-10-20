// A chat tab open in a layout-owner build: the window sends the open under the chat's own tab id;
// main's frame draws the tab, and only then does the window select it. The returned tab names
// what the frame will draw; a caller acting on it in the store waits with `afterPendingTab`.

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { defaultAgentChatLabel } from '../../../shared/agent-session-chat-label'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { openContentTabThroughLayoutOwner } from '@/runtime/layout-owner-content-tab-open'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import { contentTabOpenPlacement } from '@/store/slices/tabs/content-tab-open-placement'

export type AgentSessionTabOpen = {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
  targetGroupId?: string
  afterTabId?: string
  activate: boolean
  /** Today's draw, for a twin main may route to a paired server. */
  drawHere: () => Tab
}

/** Null when main is not asked (a paired server owns the workspace's layout): draw as today. */
export function openAgentSessionTabThroughLayoutOwner(open: AgentSessionTabOpen): Tab | null {
  const { worktreeId, sessionId } = open
  const state = useAppStore.getState()
  const tabId = structuredAgentSessionTabId(sessionId)
  const label = defaultAgentChatLabel(open.agent)
  const placement = contentTabOpenPlacement(state, worktreeId, tabId, {
    targetGroupId: open.targetGroupId,
    afterTabId: open.afterTabId,
    executionHostId: open.executionHostId
  })
  if (!placement) {
    return null
  }
  const tab: Tab = {
    id: tabId,
    entityId: sessionId,
    groupId: placement.groupId,
    worktreeId,
    executionHostId: open.executionHostId,
    contentType: 'agent-session',
    agentSessionAgent: open.agent,
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now()
  }
  // A second launch of the same chat waits for the first open.
  if (hasPendingEntityTab(worktreeId, sessionId)) {
    return tab
  }
  const sent = openContentTabThroughLayoutOwner(state, {
    worktreeId,
    entityId: sessionId,
    command: { type: 'openAgentSessionTab', tabId, sessionId, agent: open.agent, ...placement },
    facts: { label },
    shown: (shownId) => {
      if (!open.activate) {
        return
      }
      const current = useAppStore.getState()
      const groupId = current.unifiedTabsByWorktree[worktreeId]?.find(
        (t) => t.id === shownId
      )?.groupId
      if (groupId) {
        current.focusGroup(worktreeId, groupId)
      }
      current.activateTab(shownId, { worktreeId })
      current.setActiveTabType('agent-session', worktreeId)
    },
    drawHere: () => open.drawHere().id
  })
  return sent ? tab : null
}
