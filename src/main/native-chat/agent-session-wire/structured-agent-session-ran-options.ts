// A chat with no saved model keeps the options its first turn ran as its own: the message's
// choices, else what its agent reports running. A default the host filled in is never one.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-option-intent'

type RanOptionsContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'agents'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  now: () => number
}

type RanOptions = Partial<Record<'model' | 'effort' | 'serviceTier' | 'fastMode', string>>

/** In memory per child: what it last reported running, and whether a turn it was handed still
 *  owes a record because nothing had reported a model yet. */
const childRuns = new WeakMap<
  StructuredAgentSessionProviderChild,
  { reported?: RanOptions; owed?: true }
>()

function currentChild(context: RanOptionsContext, sessionId: string, fence: number) {
  const child = context.sessions.get(sessionId)?.child
  return child?.fence === fence ? child : null
}

/** What a child last reported running, which a turn handed over with no choices of its own runs. */
export function structuredAgentSessionChildRan(
  child: StructuredAgentSessionProviderChild
): RanOptions | undefined {
  return childRuns.get(child)?.reported
}

function reportedRan(reported: AgentSessionOptionsResult['current']): RanOptions | null {
  const { model, effort, serviceTier, fastMode, fastModeState } = reported
  const filled = reported.defaulted ?? []
  if (!model || model === 'default' || filled.includes('model')) {
    return null
  }
  return {
    model,
    ...(effort && !filled.includes('effort') ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    // Fast that is on but not routed fast never ran.
    ...(fastMode === false || (fastMode && fastModeState === 'on')
      ? { fastMode: String(fastMode) }
      : {})
  }
}

/** Notes what a child reports running; a turn handed over before any report records it now. */
export async function noteStructuredAgentSessionReportedOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  reported: AgentSessionOptionsResult['current']
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const ran = reportedRan(reported)
  if (!child || !ran) {
    return
  }
  const runs = childRuns.get(child)
  childRuns.set(child, { reported: ran })
  if (runs?.owed) {
    await recordStructuredAgentSessionRanOptions(context, sessionId, fence, undefined)
  }
}

/** Records, for a chat's child at `fence`, what a message handed over to it ran. */
export type StructuredAgentSessionRanRecorder = (
  sessionId: string,
  fence: number
) => (message: AgentSessionExecutionOptions | undefined) => Promise<void>

/** After a turn was handed over; bookkeeping, so a failure is logged and never refuses the send. */
export async function recordStructuredAgentSessionRanOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  message: AgentSessionExecutionOptions | undefined
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const { store, logger, agents } = context.deps
  const record = store.getRecord(sessionId)
  if (!child || !record || record.options?.model !== undefined) {
    return
  }
  const reported = childRuns.get(child)?.reported
  const model = message?.model ?? reported?.model
  childRuns.set(child, { ...(reported ? { reported } : {}), ...(model ? {} : { owed: true }) })
  if (!model) {
    return
  }
  // The report's other values ran only with its own model.
  const report = reported?.model === model ? reported : {}
  const ran: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    model,
    effort: message?.effort ?? report.effort,
    serviceTier: message?.serviceTier ?? report.serviceTier,
    fastMode: message?.fastMode ?? report.fastMode
  })) {
    // Never an option every later send would carry and the agent refuse as a choice.
    if (
      value &&
      !structuredAgentSessionOptionOverridesRefusal(agents, record.provider, { [key]: value })
    ) {
      ran[key] = value
    }
  }
  if (!ran.model) {
    return
  }
  await store
    .recordRanOptions({ sessionId, fence: child.fence, options: ran, now: context.now() })
    .catch((error: unknown) =>
      logger.warn('recording the options a turn ran failed', {
        scope: 'ran-options',
        sessionId,
        error
      })
    )
}
