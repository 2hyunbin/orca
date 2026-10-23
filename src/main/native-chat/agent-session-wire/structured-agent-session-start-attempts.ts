import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import { structuredAgentSessionStartFlightLock } from './structured-agent-session-start-flight'
import { isStructuredAgentSessionStartupExpired } from './structured-agent-session-startup-attempt-contract'
import { refusedStructuredAgentSessionStart } from './structured-agent-session-start-eligibility'
import {
  refusedStructuredAgentSessionStart as failedStart,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { oldestQueuedSubmission } from './structured-agent-session-start-failure-row'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { sameProviderChild } from './structured-agent-session-provider-child'

export function registerStructuredAgentSessionStart(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined,
  run: (
    lock: StructuredAgentSessionAttachLock,
    attemptId: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
): Promise<StructuredAgentSessionResumeOutcome> {
  const { startFlights: flights, startupAttempts: attempts, acquireAborts } = context.runtimeState
  const acquire = acquireAborts.begin(sessionId)
  let attemptId = randomUUID()
  let handle = attempts.begin(sessionId, attemptId)
  const registeredAt = handle.registeredAt
  const children: NonNullable<ReturnType<typeof flights.get>>['children'] = []
  const register = () =>
    flights.register(sessionId, {
      attemptId,
      outcome,
      abort: acquire.abort,
      signal: acquire.signal,
      children
    })
  const outcome = context.tasks.trackAttach(
    Promise.resolve()
      .then(async () => {
        let result: StructuredAgentSessionResumeOutcome = {
          ok: false,
          refusal: startFailure().refusal
        }
        for (let number = 0; number < 5; number++) {
          throwIfSignalAborted(acquire.signal)
          if (attempts.pastCeiling(registeredAt)) {
            result = { ...startFailure(), expired: true }
            break
          }
          const lock = structuredAgentSessionStartFlightLock({
            sessionId,
            attemptId,
            signal: acquire.signal,
            flights,
            serialize: context.serialize
          })
          const stillQueued = await lock.commit(
            async () =>
              !startedFor ||
              context.sessions
                .get(sessionId)
                ?.journal.submissions()
                .some(
                  (entry) =>
                    entry.clientMessageId === startedFor && isQueuedAgentJournalSubmission(entry)
                )
          )
          if (!stillQueued) {
            return { ok: false, aborted: true, refusal: startFailure().refusal }
          }
          result = await run(lock, attemptId)
          if (result.ok) {
            const ready = await lock.wait(handle.ended)
            throwIfSignalAborted(acquire.signal)
            if (ready === 'ready') {
              return result
            }
            result = await lock.commit(async () => {
              const session = context.sessions.get(sessionId)
              const ended = session?.lastEndedChild
              const child = handle.result.child
              if (
                !child ||
                !ended ||
                !sameProviderChild(ended, child) ||
                !ended.rootGone ||
                (session?.child && sameProviderChild(session.child, child))
              ) {
                return refusedStructuredAgentSessionStart(
                  'agent_session_ownership_unknown',
                  { reason: 'ownerUnproven' },
                  'The previous agent process could not be verified as stopped.'
                )
              }
              return {
                ok: false as const,
                refusal: startFailure().refusal,
                startKey: ended.generation,
                failure:
                  handle.result.failure ??
                  ended.failure ??
                  agentSessionFailureFact('providerExited'),
                retry: handle.result.retry ?? ended.cause === 'exit'
              }
            })
          }
          if (result.ok || result.aborted || result.expired || !result.retry || number === 4) {
            break
          }
          attempts.abandon(sessionId, attemptId)
          await waitForPromiseWithSignal(delay(100 * 2 ** number), acquire.signal)
          throwIfSignalAborted(acquire.signal)
          attemptId = randomUUID()
          handle = attempts.begin(sessionId, attemptId, registeredAt)
          register()
        }
        return result
      })
      .catch((error: unknown) => {
        if (!acquire.signal.aborted) {
          context.deps.logger.warn('starting the agent failed', { sessionId, error })
          return { ...startFailure(), failure: agentSessionFailureFact('hostFault') }
        }
        const expired = isStructuredAgentSessionStartupExpired(acquire.signal.reason)
        return {
          ok: false as const,
          refusal: startFailure().refusal,
          ...(expired ? { expired: true as const } : { aborted: true as const })
        }
      })
      .then(async (result) => {
        if (!result.ok && !result.aborted) {
          await context.serialize(sessionId, async () => {
            const session = context.sessions.get(sessionId)
            if (session && !oldestQueuedSubmission(session)) {
              const record = context.deps.store.getRecord(sessionId)
              const failure = failedStart(record, result)
              await recordStructuredAgentSessionStartFailure(
                { journal: session.journal, fence: record?.lease.runtimeFence ?? 0 },
                {
                  startKey: failure.startKey ?? attemptId,
                  ...structuredAgentSessionStartFailure(
                    failure.cause,
                    structuredAgentSessionFailureWordsContext(record)
                  )
                }
              )
            }
          })
        }
        return result
      })
      .finally(() => {
        acquire.end()
        flights.end(sessionId, attemptId)
        attempts.abandon(sessionId, attemptId)
        context.publishStatus(sessionId)
      })
  )
  register()
  return outcome
}

function startFailure(): Extract<StructuredAgentSessionResumeOutcome, { ok: false }> {
  return {
    ok: false,
    refusal: refuseUnclassified(
      'agent_session_owner_restart_failed',
      agentSessionWriteNoticeEnglish(['restartFailed'])
    )
  }
}
