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
    agent: string | undefined
    providerSession: AgentProviderSessionMetadata | undefined
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
 * Main refused `paneKey`'s saved resume because a native chat owns that conversation. Forgets it
 * everywhere this renderer kept it, whether or not the pane is mounted, so nothing offers or
 * retries it. Main already forgot its own copy, so nothing is sent back.
 */
export function forgetRefusedPaneResume(
  state: AppState,
  paneKey: string,
  refused: RefusedPaneResume
): void {
  const names = (claim: Parameters<typeof namesRefusedResume>[1]) =>
    namesRefusedResume(refused, claim)
  const live = state.agentStatusByPaneKey[paneKey]
  const retained = state.retainedAgentsByPaneKey[paneKey]
  if (retained && names({ ...retained.entry, agent: retained.agentType })) {
    state.dismissRetainedAgent(paneKey)
  }
  const tabId = parsePaneKey(paneKey)?.tabId
  const tab = tabId
    ? Object.values(state.tabsByWorktree)
        .flat()
        .find((candidate) => candidate.id === tabId)
    : undefined
  const worktreeId =
    tab?.worktreeId ?? state.sleepingAgentSessionsByPaneKey[paneKey]?.worktreeId ?? live?.worktreeId
  // Why: a pane already on another conversation keeps that one's row, launch config and hint;
  // its next capture replaces its own saved record.
  const movedOn = live !== undefined && !names({ ...live, agent: live.agentType })
  // Why this worktree: another host's or namespace's copy of the id is another conversation, and
  // legacy aliases of this pane hold duplicates of it here.
  const sleeping = Object.entries(state.sleepingAgentSessionsByPaneKey).flatMap(([key, record]) =>
    record.worktreeId === worktreeId && names(record) && !(movedOn && key === paneKey) ? [key] : []
  )
  if (sleeping.length > 0) {
    state.clearSleepingAgentSessionsByPaneKey(sleeping)
  }
  if (movedOn) {
    return
  }
  // Why also with no row: the launch config the pane registered for the refused resume goes too.
  state.removeAgentStatus(paneKey)
  const hint = state.paneForegroundAgentByPaneKey[paneKey]
  if (hint?.agentEvidence === 'launch-record' && hint.agent === refused.agent) {
    state.clearPaneForegroundAgent(paneKey)
  }
  // Why only this pane's tab: the chat's own tab carries the same conversation's title.
  if (
    tab?.aiVaultTitle?.agent === refused.agent &&
    tab.aiVaultTitle.sessionId === refused.providerSession.id
  ) {
    state.setAiVaultTabTitle(tab.id, null)
  }
}
