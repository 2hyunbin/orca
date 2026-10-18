import { refuse, type AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionSetOptionInput } from './structured-agent-session-adapter'

export async function performSetOption(
  ctx: Pick<
    AgentSessionTurnContext,
    'sessionId' | 'adapter' | 'fence' | 'persistOptions' | 'publish'
  >,
  input: { key: string; value: string },
  signal?: AbortSignal,
  catalogListing?: StructuredAgentSessionSetOptionInput['catalogListing']
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  let applied: void | Readonly<Record<string, string>>
  try {
    applied = await ctx.adapter.setOption({
      sessionId: ctx.sessionId,
      ...input,
      fence: ctx.fence,
      ...(catalogListing !== undefined ? { catalogListing } : {}),
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        ok: false,
        refusal: refuse(
          'agent_session_operation_invalid',
          { reason: error.refusalReason },
          error.message
        )
      }
    }
    throw error
  }
  await ctx.persistOptions(applied ?? { [input.key]: input.value })
  ctx.publish()
  return { ok: true, value: { ...input, ...(applied ? { options: { ...applied } } : {}) } }
}
