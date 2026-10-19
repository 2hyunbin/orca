// A chat with no saved model keeps the first model one of its turns ran as its own: the message's
// model, else the one its agent reports running. A default the host filled in is never one.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-option-intent'

type RanModelContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'agents'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  now: () => number
}

/** In memory per child: the model it last reported running, and whether a turn it was handed
 *  still owes a record because nothing had reported one yet. */
const childRuns = new WeakMap<object, { reported?: string; owed?: true }>()

function currentChild(context: RanModelContext, sessionId: string, fence: number) {
  const child = context.sessions.get(sessionId)?.child
  return child?.fence === fence ? child : null
}

/** Notes what a child reports running; a turn handed over before any report records it now. */
export async function noteStructuredAgentSessionReportedModel(
  context: RanModelContext,
  sessionId: string,
  fence: number,
  reported: AgentSessionOptionsResult['current']
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const { model } = reported
  if (!child || !model || model === 'default' || reported.defaulted?.includes('model')) {
    return
  }
  const runs = childRuns.get(child)
  childRuns.set(child, { reported: model })
  if (runs?.owed) {
    await recordStructuredAgentSessionRanModel(context, sessionId, fence, undefined)
  }
}

/** After a turn was handed over; bookkeeping, so a failure is logged and never refuses the send. */
export async function recordStructuredAgentSessionRanModel(
  context: RanModelContext,
  sessionId: string,
  fence: number,
  messageModel: string | undefined
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const { store, logger, agents } = context.deps
  const record = store.getRecord(sessionId)
  if (!child || !record || record.options?.model !== undefined) {
    return
  }
  const reported = childRuns.get(child)?.reported
  const model = messageModel ?? reported
  childRuns.set(child, { ...(reported ? { reported } : {}), ...(model ? {} : { owed: true }) })
  // Never a model every later send would carry and the agent refuse as a choice.
  if (!model || structuredAgentSessionOptionOverridesRefusal(agents, record.provider, { model })) {
    return
  }
  await store
    .recordRanModel({ sessionId, fence: child.fence, model, now: context.now() })
    .catch((error: unknown) =>
      logger.warn('recording the model a turn ran failed', { scope: 'ran-model', sessionId, error })
    )
}
