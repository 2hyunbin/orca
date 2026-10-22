import {
  AiVaultSearchEligibleSessionsSchema,
  type AiVaultSearchEligibleSessions
} from '../../../../shared/ai-vault-search-eligible-sessions'
import { isAiVaultAgent } from '../../../../shared/ai-vault-types'
import { agentEntryPromptCandidates } from '../../../../shared/ai-vault-session-prompt-match'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import {
  resolveOriginalPaneTarget,
  type OriginalPaneState
} from '../right-sidebar/ai-vault-original-pane'

/** Pane resolution must use the same local workspace scope as host retrieval. */
export function paletteTranscriptPaneState(
  state: OriginalPaneState,
  workspaces: readonly Worktree[],
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
): OriginalPaneState {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  const tabsByWorktree = Object.fromEntries(
    Object.entries(state.tabsByWorktree)
      .filter(([workspaceId]) => workspaceIds.has(workspaceId))
      .map(([workspaceId, tabs]) => {
        const remoteTabIds = new Set(
          (unifiedTabsByWorktree[workspaceId] ?? [])
            .filter(
              (tab) =>
                tab.contentType === 'terminal' &&
                tab.executionHostId &&
                tab.executionHostId !== LOCAL_EXECUTION_HOST_ID
            )
            .map((tab) => tab.entityId)
        )
        return [workspaceId, tabs.filter((tab) => !remoteTabIds.has(tab.id))]
      })
  )
  return {
    ...state,
    agentStatusByPaneKey: Object.fromEntries(
      Object.entries(state.agentStatusByPaneKey).filter(
        ([, entry]) => !entry.worktreeId || workspaceIds.has(entry.worktreeId)
      )
    ),
    retainedAgentsByPaneKey: Object.fromEntries(
      Object.entries(state.retainedAgentsByPaneKey).filter(
        ([, retained]) => retained && workspaceIds.has(retained.worktreeId)
      )
    ),
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
        ([, entry]) => entry && workspaceIds.has(entry.worktreeId)
      )
    ),
    tabsByWorktree
  }
}

/** Compact projection of the original-pane lookup, including its legacy prompt fallback. */
export function paletteTranscriptEligibility(
  state: OriginalPaneState
): AiVaultSearchEligibleSessions | null {
  const providers = new Map<string, AiVaultSearchEligibleSessions['providers'][number]>()
  const prompts: AiVaultSearchEligibleSessions['prompts'] = []
  const entries = [
    ...Object.values(state.agentStatusByPaneKey).map((entry) => ({
      entry,
      agent: entry.agentType
    })),
    ...Object.values(state.retainedAgentsByPaneKey).flatMap((retained) =>
      retained
        ? [
            {
              entry: {
                ...retained.entry,
                worktreeId: retained.worktreeId,
                tabId: retained.entry.tabId ?? retained.tab.id
              },
              agent: retained.agentType
            }
          ]
        : []
    ),
    ...Object.values(state.sleepingAgentSessionsByPaneKey).flatMap((entry) =>
      entry ? [{ entry, agent: entry.agent }] : []
    )
  ]
  for (const { entry, agent } of entries) {
    if (
      !isAiVaultAgent(agent) ||
      !resolveOriginalPaneTarget({
        state,
        paneKey: entry.paneKey,
        worktreeIdHint: entry.worktreeId,
        tabIdHint: entry.tabId
      })
    ) {
      continue
    }
    if (entry.providerSession) {
      const provider = { agent, sessionId: entry.providerSession.id }
      providers.set(JSON.stringify([provider.agent, provider.sessionId]), provider)
    } else if (entry.providerSession === undefined && 'prompt' in entry) {
      const candidates = agentEntryPromptCandidates(entry)
      if (candidates.length) {
        prompts.push({ agent, prompts: candidates })
      }
    }
  }
  const parsed = AiVaultSearchEligibleSessionsSchema.safeParse({
    providers: [...providers.values()],
    prompts
  })
  return parsed.success ? parsed.data : null
}
