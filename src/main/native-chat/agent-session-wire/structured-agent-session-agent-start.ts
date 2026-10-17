// Giving a session its provider child back.
//
// Only work starts one: the delivery loop for a queued message, and the few operations that need
// the provider itself — never a view, and never the app launching. It runs outside the session's
// serialize as one registered flight (`structured-agent-session-start-flight`), so a message sent
// meanwhile is accepted at once; each of its writes is a fenced commit under the serialize.

import {
  providerDiagnosticOf,
  type AgentSessionArgumentProblem,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import { argumentProblemOf } from '../structured-agent-arguments-error'
import {
  agentSessionRefusalFromReference,
  readAgentSessionRefusalReference,
  refuseUnclassified
} from '../../../shared/agent-session-wire-refusals'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { randomUUID } from 'node:crypto'
import { attachStructuredAgentSessionForStart } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { structuredAgentSessionStartFlightLock } from './structured-agent-session-start-flight'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt-contract'
import { failedCreateRefusal } from './structured-agent-session-failed-create-refusal'
import {
  joinClosingStructuredAgentSessionChild,
  releaseLeaseOfEndedStructuredAgentSessionChild
} from './structured-agent-session-child-close'
export { joinClosingStructuredAgentSessionChild }
import {
  refusedStructuredAgentSessionStart,
  structuredAgentSessionStartParams
} from './structured-agent-session-start-eligibility'

/** A resume answers with the attach's own refusal, verdict and all, so the asker can tell a lease
 *  someone else is settling from an owner that will not come back. */
export type StructuredAgentSessionResumeOutcome =
  | { ok: true }
  | {
      ok: false
      refusal: AgentSessionWireRefusal
      /** What the provider said about the failed start, for the chat's own record; host-side
       *  only, never on the refusal. */
      diagnostic?: ProviderDiagnostic
      /** The host's own close, Stop or quit aborted the start, so it failed nothing it was for. */
      aborted?: true
      /** The start went silent or hit its ceiling before it proved itself: Orca stopped it. */
      expired?: true
      argumentProblem?: AgentSessionArgumentProblem
    }

/** The attach's caller key: the ledger row a start settles is Orca's own. */
const AGENT_START_CALLER_KEY = 'trusted-local:agent-start'

/**
 * Gives the session a provider child if it has none, for a caller OUTSIDE its serialize. The short
 * step that registers the start is what makes "if it has none" exact: a second asker finds the
 * first one's child, or joins its start. A failed start leaves the next asker to make its own.
 */
export async function startStructuredAgentSessionAgent(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor?: string
): Promise<StructuredAgentSessionResumeOutcome> {
  // Wrapped, so the step settles at registration and never waits on the start it registered.
  const registered = await context.serialize<{
    outcome: Promise<StructuredAgentSessionResumeOutcome>
  }>(sessionId, async () => {
    const child = context.sessions.get(sessionId)?.child
    if (child && !child.close) {
      return { outcome: Promise.resolve({ ok: true }) }
    }
    return {
      outcome:
        context.runtimeState.startFlights.get(sessionId)?.outcome ??
        registerStart(context, sessionId, startedFor)
    }
  })
  return registered.outcome
}

/** The same, for an operation's admission: a start that throws is that operation's refusal. */
export function startStructuredAgentSessionAgentForOperation(
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<StructuredAgentSessionResumeOutcome> {
  return startStructuredAgentSessionAgent(context, sessionId).catch((error: unknown) => {
    // The error is Orca's own and goes to the log; the refusal says only that the start failed.
    context.deps.logger.warn('starting the agent for an operation failed', {
      scope: 'operation-agent-start',
      sessionId,
      error
    })
    return { ok: false, refusal: startFailedRefusal() }
  })
}

/** Inside the register step, before any wait: the controller a Stop, close or quit aborts, the
 *  startup clock, and quit's drain all cover the start from here. */
function registerStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined
): Promise<StructuredAgentSessionResumeOutcome> {
  const { runtimeState } = context
  const attemptId = randomUUID()
  const acquire = runtimeState.acquireAborts.begin(sessionId)
  runtimeState.startupAttempts.begin(sessionId, attemptId)
  const lock = structuredAgentSessionStartFlightLock({
    sessionId,
    attemptId,
    signal: acquire.signal,
    flights: runtimeState.startFlights,
    serialize: context.serialize
  })
  const outcome = context.tasks.trackAttach(
    Promise.resolve()
      .then(() => runStart(context, sessionId, startedFor, lock, attemptId))
      .catch((error: unknown) => {
        if (!acquire.signal.aborted) {
          throw error
        }
        const expired = isStructuredAgentSessionStartupExpired(acquire.signal.reason)
        return {
          ok: false as const,
          refusal: startFailedRefusal(),
          ...(expired ? { expired: true as const } : { aborted: true as const })
        }
      })
      .finally(() => {
        acquire.end()
        runtimeState.startFlights.end(sessionId, attemptId)
        runtimeState.startupAttempts.abandon(sessionId, attemptId)
      })
  )
  runtimeState.startFlights.register(sessionId, { attemptId, outcome })
  return outcome
}

async function runStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined,
  lock: StructuredAgentSessionAttachLock,
  attemptId: string
): Promise<StructuredAgentSessionResumeOutcome> {
  // A child a stop began closing takes no input, and none may start beside it: the start waits on
  // that close, and is refused while its exit stays unverifiable.
  const closed = await joinClosingStructuredAgentSessionChild(context, sessionId, lock)
  if (!closed.ok) {
    return closed
  }
  const callerKey = AGENT_START_CALLER_KEY
  // The record is read only once this host has adjudicated it and recovery resolution has
  // concluded about any owner a failed attempt left in `recovering`, so the eligibility below sees
  // the lease the resolver handed back. Both probe outside; each commits in the store's own
  // transaction, against the owner identity it probed.
  const unreconciled = await lock.wait(context.reconcileLeases(sessionId))
  if (unreconciled) {
    return { ok: false, refusal: unreconciled }
  }
  await lock.wait(context.runtimeState.resolveRecovery(sessionId))
  const eligible = await lock.commit(async () => {
    // A start needs the lease released; a release the exit's own wind-down could not write is
    // re-derived from this host's proof of that exit, never refused on.
    await releaseLeaseOfEndedStructuredAgentSessionChild(context, sessionId)
    return structuredAgentSessionStartParams(context, sessionId, startedFor)
  })
  if (!eligible.ok) {
    return eligible
  }
  const { params, startupOptions } = eligible
  let attached: AgentSessionMutationResult<AgentSessionAttachResult>
  let acquisitionError: unknown
  let aborted = false
  let expired = false
  let published = false
  try {
    attached = await attachStructuredAgentSessionForStart(context, callerKey, params, {
      lock,
      startupAttemptId: attemptId,
      ...(startedFor === undefined ? {} : { startedFor }),
      ...(startupOptions ? { startupOptions } : {}),
      onAcquisitionFailed: (error) => {
        acquisitionError = error
      },
      onAborted: () => {
        aborted = true
      },
      onStartupExpired: () => {
        expired = true
      },
      onPublished: () => {
        published = true
      }
    })
  } catch (error) {
    // The attach settles an acquisition that failed — the ledger row, the released lease — before
    // it rethrows the cause. That row is the answer: a failure it recorded is this resume's
    // refusal, verdict and all. Only an error it did not record is a fault for the caller.
    const settled = settledResumeRefusal(
      context,
      callerKey,
      params.envelope.clientOperationId,
      sessionId,
      error
    )
    if (settled) {
      return withDiagnostic(settled.refusal, error, { aborted, expired })
    }
    throw error
  }
  if (!attached.ok) {
    return withDiagnostic(attached.refusal, acquisitionError, { aborted, expired })
  }
  return published
    ? { ok: true }
    : refusedStructuredAgentSessionStart(
        'agent_session_ownership_unknown',
        { reason: 'noProviderChild' },
        'The session attached without a provider child to write to.'
      )
}

function startFailedRefusal(): AgentSessionWireRefusal {
  return refuseUnclassified(
    'agent_session_owner_restart_failed',
    agentSessionWriteNoticeEnglish(['restartFailed'])
  )
}

function withDiagnostic(
  refusal: AgentSessionWireRefusal,
  error: unknown,
  { aborted, expired }: { aborted: boolean; expired: boolean }
): StructuredAgentSessionResumeOutcome {
  const diagnostic = providerDiagnosticOf(error)
  const argumentProblem = argumentProblemOf(error)
  return {
    ok: false,
    refusal,
    ...(diagnostic ? { diagnostic } : {}),
    ...(aborted ? { aborted: true as const } : {}),
    ...(expired ? { expired: true as const } : {}),
    ...(argumentProblem ? { argumentProblem } : {})
  }
}

function settledResumeRefusal(
  context: Pick<StructuredAgentSessionAttachContext, 'deps'>,
  callerKey: string,
  operationId: string,
  sessionId: string,
  error: unknown
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const outcome = context.deps.store.getOperationRow(callerKey, operationId)?.outcome
  const reference =
    outcome?.status === 'failed'
      ? readAgentSessionRefusalReference({ code: outcome.code, details: outcome.details })
      : undefined
  if (outcome?.status !== 'failed' || !reference) {
    return null
  }
  return failedCreateRefusal(
    agentSessionRefusalFromReference(
      reference,
      outcome.message ?? (error instanceof Error ? error.message : String(error))
    ),
    outcome.status,
    context.deps.store.getRecord(sessionId)
  )
}
