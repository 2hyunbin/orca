import type { AgentProviderSessionMetadata } from './agent-session-resume'

/** Older hosts' strict ensureAgentSession schema rejects the newer `cwd` and `effort` fields. */
export function agentProviderSessionForEnsure(
  providerSession: AgentProviderSessionMetadata,
  hostAcceptsEffort = false
): AgentProviderSessionMetadata {
  const { cwd: _cwd, effort, ...identity } = providerSession
  return hostAcceptsEffort && effort ? { ...identity, effort } : identity
}
