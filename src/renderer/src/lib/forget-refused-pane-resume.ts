import type { AppState } from '@/store/types'
import type { RefusedPaneResume } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** Whether a saved claim names the refused conversation. Only local claims can: the host judged
 *  its own chats, and a remote host's same id is a different conversation. */
export function namesRefusedResume(
  refused: RefusedPaneResume,
  claim: {
    agent?: string
    providerSession?: AgentProviderSessionMetadata
    connectionId?: string | null
  }
): boolean {
  return (
    !claim.connectionId &&
    claim.agent === refused.agent &&
    agentProviderSessionsEqual(refused.agent, claim.providerSession, refused.providerSession)
  )
}

/**
 * Main refused `paneKey`'s saved resume because a native chat owns that conversation. Forgets it as
 * this pane's, whether or not the pane is mounted, so nothing offers or retries it here. Another
 * pane holding the same conversation is refused and forgotten at its own restore. Main already
 * forgot its own copy, so nothing is sent back.
 */
export function forgetRefusedPaneResume(
  state: AppState,
  paneKey: string,
  refused: RefusedPaneResume
): void {
  const names = (claim: Parameters<typeof namesRefusedResume>[1]) =>
    namesRefusedResume(refused, claim)
  const retained = state.retainedAgentsByPaneKey[paneKey]
  if (retained && names({ ...retained.entry, agent: retained.agentType })) {
    state.dismissRetainedAgent(paneKey)
  }
  const live = state.agentStatusByPaneKey[paneKey]
  // Why: a pane already on another conversation keeps that one's row, record, launch config and hint.
  if (live && !names({ ...live, agent: live.agentType })) {
    return
  }
  const tabId = parsePaneKey(paneKey)?.tabId ?? paneKey.split(':')[0]
  // Why the tab's other keys: legacy aliases of this pane can hold duplicates of its record.
  const saved = Object.entries(state.sleepingAgentSessionsByPaneKey).flatMap(([key, record]) =>
    (key === paneKey || key.startsWith(`${tabId}:`)) && names(record) ? [key] : []
  )
  if (saved.length > 0) {
    state.clearSleepingAgentSessionsByPaneKey(saved)
  }
  // Why also with no row: the launch config the pane registered for the refused resume goes too.
  state.removeAgentStatus(paneKey)
  const hint = state.paneForegroundAgentByPaneKey[paneKey]
  if (hint?.agentEvidence === 'launch-record' && hint.agent === refused.agent) {
    state.clearPaneForegroundAgent(paneKey)
  }
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  // Why only this pane's tab: the chat's own tab carries the same conversation's title.
  if (
    tab?.aiVaultTitle?.agent === refused.agent &&
    tab.aiVaultTitle.sessionId === refused.providerSession.id
  ) {
    state.setAiVaultTabTitle(tab.id, null)
  }
}
