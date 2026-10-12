import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../shared/agent-session-mutation-envelope'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import {
  openForWrite,
  openForProviderWrite,
  rewindInDoubt
} from './structured-agent-session-send-preparation'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import type { AgentSessionMutationSessionPreparation } from './structured-agent-session-mutation-admission'

export type ReadyOperationChild = StructuredAgentSessionProviderChildIdentity | null
export type ReadyOperationSelection = {
  ok: true
  child: ReadyOperationChild
  replay?: true
  deadline?: number
}

/** A send or conversation command waits only when an earlier rewind needs its provider. */
export async function runAfterRewindStart<T>(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  method: string,
  fields: Record<string, unknown>,
  run: (
    selection: ReadyOperationSelection,
    alreadySerialized: boolean
  ) => Promise<AgentSessionMutationResult<T>>
): Promise<AgentSessionMutationResult<T>> {
  const first = await context.serialize(envelope.sessionId, async () =>
    rewindInDoubt(context.deps.store.getRecord(envelope.sessionId))
      ? { needsStart: true as const }
      : { needsStart: false as const, result: await run({ ok: true, child: null }, true) }
  )
  if (!first.needsStart) {
    return first.result
  }
  const selected = await prepareReadyStructuredAgentSessionOperation(
    context,
    callerKey,
    envelope,
    method,
    fields
  )
  return selected.ok ? run(selected, false) : selected
}

function notRun(): { ok: false; refusal: AgentSessionWireRefusal } {
  return {
    ok: false,
    refusal: refuseUnclassified(
      'agent_session_owner_restart_failed',
      'The operation did not run because the agent did not finish starting.'
    )
  }
}

/** Select a child in the session queue, then wait for that attempt outside it. */
export async function prepareReadyStructuredAgentSessionOperation(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope,
  method: string,
  fields: Record<string, unknown>,
  beforeAgent?: (
    record: AgentSessionRecord | null
  ) => AgentSessionMutationSessionPreparation | null,
  budgetMs = STRUCTURED_AGENT_SESSION_START_WAIT_MS
): Promise<ReadyOperationSelection | { ok: false; refusal: AgentSessionWireRefusal }> {
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method,
    sessionId: envelope.sessionId,
    fields
  })
  const conflict = agentSessionFingerprintConflict(envelope, hostFingerprint)
  if (conflict) {
    return { ok: false, refusal: conflict }
  }
  const evaluated = context.deps.store.evaluateMutationOperation({
    callerKey,
    envelope,
    hostFingerprint,
    now: context.now()
  })
  if (!evaluated || evaluated.decision.decision !== 'admit') {
    return {
      ok: true,
      child: null,
      ...(evaluated?.decision.decision === 'replay' ? { replay: true as const } : {})
    }
  }
  const deadline = Date.now() + budgetMs
  const selected = await context
    .serialize(envelope.sessionId, async () => {
      const opened = await openForWrite(context, envelope)()
      if (!opened.ok) {
        return opened
      }
      const checked = beforeAgent?.(context.deps.store.getRecord(envelope.sessionId))
      if (checked && !checked.ok) {
        return checked
      }
      const ensured = await context.ensureAgent(envelope.sessionId)
      if (!ensured.ok) {
        return ensured
      }
      const child = context.sessions.get(envelope.sessionId)?.child
      if (!child || child.close) {
        return notRun()
      }
      const identity = { generation: child.generation, fence: child.fence }
      if (child.phase === 'ready') {
        return { ok: true as const, child: identity }
      }
      const readiness = context.startupAttempts.readiness(envelope.sessionId, identity)
      return readiness ? { ok: true as const, child: identity, readiness } : notRun()
    })
    .catch((error: unknown) => {
      context.deps.logger.warn('selecting an agent for an operation failed', {
        scope: 'operation-agent-start',
        sessionId: envelope.sessionId,
        error
      })
      return notRun()
    })
  if (!selected.ok || !selected.child) {
    return selected
  }
  if (Date.now() >= deadline) {
    return notRun()
  }
  if ('readiness' in selected && selected.readiness) {
    const outcome = await selected.readiness.wait(deadline - Date.now())
    if (outcome !== 'ready') {
      return notRun()
    }
  }
  if (Date.now() >= deadline) {
    return notRun()
  }
  return { ok: true, child: selected.child, deadline }
}

/** Replay uses the ledger answer; a new operation uses only its selected ready child. */
export function openWithReadyStructuredAgentSessionChild(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  selection: ReadyOperationSelection
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    const opened = await openForProviderWrite(context, envelope)()
    if (!opened.ok || ledger === 'replay') {
      return opened
    }
    if (!selection.child) {
      return selection.replay
        ? { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
        : notRun()
    }
    if (selection.deadline !== undefined && Date.now() >= selection.deadline) {
      return notRun()
    }
    const child = context.sessions.get(envelope.sessionId)?.child
    return child?.phase === 'ready' && !child.close && sameProviderChild(child, selection.child)
      ? opened
      : notRun()
  }
}
