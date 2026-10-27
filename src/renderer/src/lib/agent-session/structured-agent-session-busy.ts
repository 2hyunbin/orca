import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

/** Treat starting, active, asking, and unobservable chats as busy; an unreachable host may still be running. */
export function isStructuredAgentSessionBusy(workspaceId: string, tab: Tab): boolean {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const status = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state
  if (
    (status && status !== 'done') ||
    getStructuredAgentSessionLaunchLifecycle(workspaceId, tab.entityId) === 'pending'
  ) {
    return true
  }
  const target = structuredAgentSessionTargetForHost(tab.executionHostId)
  if (!target) {
    return true
  }
  const feed = getStructuredAgentSessionStatusFeed(target)
  return (
    feed.getSessionObservation(tab.entityId) !== 'live' ||
    feed.getSnapshot().get(tab.entityId)?.hostExecutionPhase === 'starting'
  )
}
