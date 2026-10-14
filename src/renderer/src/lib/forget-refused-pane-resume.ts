import type { AppState } from '@/store/types'
import type { RefusedPaneResume } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/**
 * Main refused `paneKey`'s saved resume because a native chat owns that conversation. Forgets it
 * everywhere this renderer kept it, whether or not the pane is mounted, so nothing offers or
 * retries it. Main already forgot its own copy, so nothing is sent back.
 */
export function forgetRefusedPaneResume(
  state: AppState,
  paneKey: string,
  refused: RefusedPaneResume
): void {
  const names = (agent: string | undefined, session: AgentProviderSessionMetadata | undefined) =>
    agent === refused.agent &&
    agentProviderSessionsEqual(refused.agent, session, refused.providerSession)
  const live = state.agentStatusByPaneKey[paneKey]
  // Why also with no row: the launch config the pane registered for the refused resume goes too.
  if (!live || names(live.agentType, live.providerSession)) {
    state.removeAgentStatus(paneKey)
  }
  const retained = state.retainedAgentsByPaneKey[paneKey]
  if (retained && names(retained.agentType, retained.entry.providerSession)) {
    state.dismissRetainedAgent(paneKey)
  }
  // Why every pane: legacy aliases can hold the same conversation under other keys.
  const sleeping = Object.entries(state.sleepingAgentSessionsByPaneKey).flatMap(([key, record]) =>
    names(record.agent, record.providerSession) ? [key] : []
  )
  if (sleeping.length > 0) {
    state.clearSleepingAgentSessionsByPaneKey(sleeping)
  }
  if (state.paneForegroundAgentByPaneKey[paneKey]?.agentEvidence === 'launch-record') {
    state.clearPaneForegroundAgent(paneKey)
  }
  // Why only this pane's tab: the chat's own tab carries the same conversation's title.
  const tabId = parsePaneKey(paneKey)?.tabId
  const tab = tabId
    ? Object.values(state.tabsByWorktree)
        .flat()
        .find((candidate) => candidate.id === tabId)
    : undefined
  if (
    tab?.aiVaultTitle?.agent === refused.agent &&
    tab.aiVaultTitle.sessionId === refused.providerSession.id
  ) {
    state.setAiVaultTabTitle(tab.id, null)
  }
}
