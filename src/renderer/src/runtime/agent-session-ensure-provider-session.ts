import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { agentProviderSessionForEnsure } from '../../../shared/agent-provider-session-ensure'
import { AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

/** The provider session an ensureAgentSession call may send to this host. */
export async function agentProviderSessionForHostEnsure(
  environmentId: string,
  providerSession: AgentProviderSessionMetadata
): Promise<AgentProviderSessionMetadata> {
  if (!providerSession.effort) {
    return agentProviderSessionForEnsure(providerSession)
  }
  try {
    const supported = await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY
    )
    return agentProviderSessionForEnsure(providerSession, supported)
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    return agentProviderSessionForEnsure(providerSession)
  }
}
