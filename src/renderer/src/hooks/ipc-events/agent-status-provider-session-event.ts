import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import type { AgentStatusBatchUpdate } from '@/store/slices/agent-status'
import type { AgentStatusApplyOptions, AgentStatusApplyResult } from './agent-status-bridge-types'

/** Applies a host row that carries only a resume identity, after the applicator routed it. */
export function applyProviderSessionOnlyStatus(args: {
  store: AppState
  data: AgentStatusIpcPayload
  paneKey: string
  routing: {
    tabId: string | undefined
    worktreeId: string | undefined
    connectionId: string | null | undefined
  }
  options: AgentStatusApplyOptions | undefined
}): AgentStatusApplyResult {
  const { store, data, paneKey, routing, options } = args
  if (!data.providerSession) {
    return 'dropped'
  }
  if (data.agentType !== 'pi') {
    // Why: a resume launch's seed names the session the relaunched process runs; the pane's
    // row from before the relaunch keeps its turn but must not keep the old transcript.
    return store.adoptLaunchedAgentProviderSession(paneKey, data.agentType, data.providerSession)
      ? 'applied'
      : 'dropped'
  }
  const providerSessionUpdate: AgentStatusBatchUpdate = {
    kind: 'providerSession',
    paneKey,
    agent: 'pi',
    providerSession: data.providerSession,
    timing: { updatedAt: data.receivedAt },
    routing: {
      tabId: routing.tabId,
      worktreeId: data.worktreeId ?? routing.worktreeId,
      ...(routing.connectionId !== undefined ? { connectionId: routing.connectionId } : {})
    },
    metadata: data.launchToken ? { launchToken: data.launchToken } : undefined
  }
  if (options?.batch) {
    return options.batch.transaction.apply(providerSessionUpdate) ? 'applied' : 'dropped'
  }
  store.recordAgentProviderSession(
    providerSessionUpdate.paneKey,
    providerSessionUpdate.agent,
    providerSessionUpdate.providerSession,
    providerSessionUpdate.timing,
    providerSessionUpdate.routing,
    providerSessionUpdate.metadata
  )
  return 'applied'
}
