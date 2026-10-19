import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import type { AgentProviderSessionUpdate } from '@/store/slices/agent-status'
import type { AgentStatusApplyResult, AgentStatusBatchContext } from './agent-status-bridge-types'

// Events that patch one aspect of an already-routed row; they never create, re-time or notify one.

export function applyProviderSessionOnlyUpdate(args: {
  store: AppState
  batch: AgentStatusBatchContext | undefined
  data: AgentStatusIpcPayload
  paneKey: string
  routing: NonNullable<AgentProviderSessionUpdate['routing']>
}): AgentStatusApplyResult {
  const { store, batch, data, paneKey, routing } = args
  if (!data.providerSession || data.agentType !== 'pi') {
    return 'dropped'
  }
  const update: AgentProviderSessionUpdate = {
    kind: 'providerSession',
    paneKey,
    agent: 'pi',
    providerSession: data.providerSession,
    timing: { updatedAt: data.receivedAt },
    routing,
    metadata: data.launchToken ? { launchToken: data.launchToken } : undefined
  }
  if (batch) {
    return batch.transaction.apply(update) ? 'applied' : 'dropped'
  }
  store.recordAgentProviderSession(
    update.paneKey,
    update.agent,
    update.providerSession,
    update.timing,
    update.routing,
    update.metadata
  )
  return 'applied'
}
