import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

/** Project the one durable conversation name onto each structured tab's display title. */
export function titleStructuredConversationTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  nameFor: (sessionId: string) => string | null | undefined
): RuntimeMobileSessionTabsSnapshot {
  let changed = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.type !== 'agent-session') {
      return tab
    }
    const title = nameFor(tab.sessionId) ?? defaultAgentChatLabel(tab.agent)
    if (tab.title === title) {
      return tab
    }
    changed = true
    return { ...tab, title }
  })
  return changed ? { ...snapshot, tabs } : snapshot
}
