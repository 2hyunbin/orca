import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { structuredAgentSessionCapabilityView } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import type { ClaudeSession } from './claude-structured-session-state'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'

/** The same raw child read serves pick validation without owning another capability cache. */
export async function projectClaudeSessionOptionPick(
  sessions: ReadonlyMap<string, ClaudeSession>,
  timeoutMs: number | undefined,
  sessionId: string,
  options: Readonly<Record<string, string>>,
  installed: readonly AgentSessionModelOption[] | undefined
) {
  const session = sessions.get(sessionId)
  if (!session || session.connection.closed) {
    return undefined
  }
  const { fence, connection, acquisitionGeneration } = session
  const live = await readClaudeStructuredSessionOptions(session, timeoutMs).catch(() => null)
  if (
    sessions.get(sessionId) !== session ||
    connection.closed ||
    session.connection !== connection ||
    session.fence !== fence ||
    session.acquisitionGeneration !== acquisitionGeneration ||
    !live?.currentModelObservation ||
    live.currentModelObservation.model !== options.model
  ) {
    return undefined
  }
  return {
    models: structuredAgentSessionCapabilityView(
      { models: installed ?? [] },
      options.model,
      live.currentModelObservation,
      [],
      live.fastModeRestriction
    ).models,
    options
  }
}
