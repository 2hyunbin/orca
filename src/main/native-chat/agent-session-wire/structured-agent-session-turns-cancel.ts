import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import {
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionCommandWasStopped,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import {
  answerCancelOfSettledPrompt,
  validatePendingPrompt
} from './structured-agent-session-prompt-state'
import {
  STOP_NOTE_CANCELLATION_REQUESTED,
  structuredAgentSessionNamedTurnScope,
  structuredAgentSessionStopNamesTurnNotLive,
  structuredAgentSessionStopNoteScope,
  structuredAgentSessionStoppedTurnId
} from './structured-agent-session-turn-stop-notes'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { StructuredAgentSessionStopWindDown } from './structured-agent-session-stop-wind-down'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'
import { settleTakenStop } from './structured-agent-session-taken-stop-settle'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Whether the fold reads working. Every write has landed by its call's return, so a Stop reads it
 *  without waiting on the write queue. */
export function isMainAgentWorking(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>
): boolean {
  return isStructuredAgentSessionMainAgentWorking(
    ctx.journal.activeTurnId(),
    ctx.journal.submissions(),
    ctx.fence
  )
}

/**
 * After an interrupt that failed: whether the session still runs what the Stop was sent for. One at
 * rest, or running a different turn, is not the Stop's to end. A child that exited reads at rest:
 * its exit ends its turn, and the host's own exit handling waits behind this step.
 */
function stillRunsStoppedTurn(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  stoppedTurnId: string | null
): boolean {
  if (!isMainAgentWorking(ctx)) {
    return false
  }
  // Working with no turn open after the Stop's turn is a later send whose turn has not opened.
  return stoppedTurnId === null || ctx.journal.activeTurnId() === stoppedTurnId
}

/** The row for a Stop the provider declined, in its words when it gave any. One that could not
 *  reach a turn still able to open says the Stop is unconfirmed, never that nothing ran. */
function stopRefusedNote(
  ctx: Pick<AgentSessionTurnContext, 'failureTextContext'>,
  refusal: AgentSessionCancelOutcome['refusal']
): AgentJournalStatusItem {
  const detail = refusal?.detail
  const fact = refusal?.turnMayOpen
    ? agentSessionFailureFact('cancelUnconfirmed')
    : agentSessionFailureFact('stopRefused', detail ? { detail } : {})
  return {
    kind: 'status',
    ...agentSessionFailureWords(fact, { ...ctx.failureTextContext, surface: 'row' })
  }
}

/** What the Stop's settle binds: the turn it stopped, and whether its wind-down closes it. */
type StopSettleBinding = {
  turnId?: string
  failedOn?: JournalStopFailedOn
  closedByWindDown?: true
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  if (input.prompt) {
    const validated = validatePendingPrompt(ctx, input.prompt)
    if (!validated.ok) {
      return answerCancelOfSettledPrompt(ctx, { ...input, prompt: input.prompt }, validated)
    }
  }
  // A person's Stop that named no turn binds what ends while it settles (`beginJournalStopSettle`).
  const settle = input.opensSettle ? ctx.journal.stopMarks.beginSettle() : null
  const binding: StopSettleBinding = {}
  // A wind-down that failed with work running on marks that work's turn, as a failed Stop does.
  const close = (failedOn?: JournalStopFailedOn): void =>
    ctx.journal.stopMarks.settled(settle, binding.turnId, binding.failedOn ?? failedOn)
  try {
    return await cancelAndNote(ctx, input, binding, close)
  } finally {
    if (!binding.closedByWindDown) {
      close()
    }
  }
}

type PerformCancelInput = {
  clientOperationId: string
  /** Absent: whatever the conversation has in flight; present: only while that turn is current. */
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
  /** Ends the provider child, for a running command the provider did not take the Stop on, or a
   *  turn whose interrupt failed. */
  stopChild?: () => Promise<void>
  /** A child end after a failed interrupt that threw. */
  onStopChildError?: (error: unknown) => void
  /** After that throw: whether the host let go of the child, its exit proven before a later
   *  cleanup step failed. */
  childReleased?: () => boolean
  /** Hands the child's end to the Stop's next serialized step, for a provider whose Stop ends
   *  its session. */
  endSession?: (windDown: StructuredAgentSessionStopWindDown) => void
  /** Whether the host's withdrawal of queued messages for this Stop withdrew any; awaited only
   *  after the interrupt. */
  withdrewQueued?: Promise<boolean>
  /** The session's child records: a background Stop reaches the tasks they offer a stop. */
  childWork?: () => readonly AgentChildWorkView[] | undefined
  /** The latest Stop event is this press's own, or the in-force one it repeats: its settle binds. */
  opensSettle?: true
}

async function cancelAndNote(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput,
  binding: StopSettleBinding,
  closeSettle: (failedOn?: JournalStopFailedOn) => void
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note: AgentJournalStatusItem | null = {
    kind: 'status',
    text: STOP_NOTE_CANCELLATION_REQUESTED
  }
  // The turn the Stop names, read before the cancel settles it: the note reports on that turn.
  const turnScope =
    (input.turnId !== undefined && !input.scope
      ? structuredAgentSessionNamedTurnScope(ctx.journal, input.turnId)
      : null) ?? ctx.journal.liveTurnScope()
  // Only the provider's end or the child's ends a command. A command the provider has not opened a
  // turn for, would not interrupt, or was already asked to stop, ends with its child; that child's
  // dead-generation settlement writes the command's verdict.
  const liveTurnId = ctx.journal.activeTurnId()
  // Read with the live turn, before the cancel settles it: the note is keyed by this turn.
  const stoppedTurnId = structuredAgentSessionStoppedTurnId(ctx.journal, input.turnId)
  const namesTurnNotLive = structuredAgentSessionStopNamesTurnNotLive(input.turnId, liveTurnId)
  const runningCommand =
    input.stopChild !== undefined &&
    liveTurnId !== null &&
    isStructuredAgentSessionCommandTurnId(liveTurnId) &&
    !namesTurnNotLive
  const stoppedBefore =
    runningCommand && structuredAgentSessionCommandWasStopped(ctx.journal, liveTurnId)
  // One rule for every agent: a chat's Stop ends its session, background work included; the next
  // send resumes the conversation. A row's Stop (`scope`) stops only that task.
  const endsSession = input.endSession !== undefined
  const stoppedAt = Date.now()
  const noteIdentity = structuredAgentSessionStopNoteIdentity(
    stoppedTurnId ?? input.clientOperationId
  )
  let stoppedTurn: string | undefined = stoppedTurnId ?? undefined
  let noteWritten = false
  const writeNote = (body: AgentJournalStatusItem): Promise<void> => {
    noteWritten = true
    return ctx.journal
      .appendItem(noteIdentity, body, {
        fence: ctx.fence,
        turnScope: structuredAgentSessionStopNoteScope(ctx.journal, stoppedTurn, turnScope)
      })
      .then(() => undefined)
      .catch((error: unknown) =>
        ctx.logger.warn('writing the Stop note failed', {
          scope: 'chat-stop-note',
          sessionId: ctx.sessionId,
          error
        })
      )
  }
  const requestNoteWrite = !input.scope && !namesTurnNotLive ? writeNote(note) : undefined
  // The provider's own answer; unset when its cancel threw, leaving the effect unknown.
  let taken: boolean | undefined
  // The provider could not interrupt the turn, or its cancel threw: the turn may run on.
  let interruptFailed = false
  let refusal: AgentSessionCancelOutcome['refusal']
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    const background =
      input.scope && !stoppedBefore
        ? await ctx.adapter.stopBackgroundTasks?.({
            sessionId: ctx.sessionId,
            fence: ctx.fence,
            taskIds: agentChildWorkStopTargets(input.childWork?.(), input.taskId)
          })
        : undefined
    // A background Stop writes no row, so a task the agent shows still running after it goes back
    // to the client that pressed it.
    if (background?.stillRunning) {
      return {
        ok: false,
        refusal: refuseUnclassified(
          'agent_session_operation_invalid',
          'a background task still runs after its stop'
        )
      }
    }
    const outcome: AgentSessionCancelOutcome = stoppedBefore
      ? { cancelled: false }
      : input.scope
        ? { cancelled: background?.cancelled === true }
        : await ctx.adapter.cancelTurn({
            sessionId: ctx.sessionId,
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
            fence: ctx.fence,
            // The journal is what the client read to name a turn, so it is what judges the request.
            resolveLiveTurnId: () => ctx.journal.activeTurnId(),
            ...(dispatchStatus ? { dispatchStatus } : {}),
            ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
          })
    taken = outcome.cancelled
    cancelled = outcome.cancelled
    refusal = outcome.refusal
    stoppedTurn = outcome.turnId
    interruptFailed = refusal !== undefined && refusal.turnNotRunning !== true
    // Working is read first: a working session never takes this branch, so a child end below never
    // waits on the withdrawal. On an idle queue the withdrawal has already landed in the fold.
    if (!cancelled && !isMainAgentWorking(ctx) && (await input.withdrewQueued) === true) {
      // A Stop that withdrew what was queued and left nothing working ended what it was sent for,
      // named or not. The journal judges it: providers differ on refusing a turn that has ended.
      cancelled = true
      note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    } else if (!cancelled && input.prompt) {
      note = null
    } else if (!cancelled && input.turnId === undefined) {
      // Sent only while the chat reads working, so a Stop that ended nothing must say why.
      note = stopRefusedNote(ctx, refusal)
    }
  } catch (error) {
    if (input.prompt) {
      throw error
    }
    // A timeout or lost contact proves nothing about the task: unconfirmed, never "not stopped".
    if (input.scope) {
      return {
        ok: false,
        refusal: refuseUnclassified(
          'agent_session_operation_unknown',
          `background task stop unconfirmed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    interruptFailed = true
    // The adapter's error is Orca's; the row says only that the stop is unconfirmed.
    note = {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
    }
  }
  // A Stop naming a turn that has since ended keeps the session only when the provider declined
  // it: an interrupt, answered or not, can stop a follow-up whose turn has not opened.
  if (endsSession && (!namesTurnNotLive || taken !== false)) {
    // An interrupt the provider took is worth waiting on, turn row or not: a Stop before the echo
    // has none, and the echo still opens the turn the Stop interrupted.
    binding.closedByWindDown = true
    // The child's end confirms the Stop, so a refused or unconfirmed interrupt says nothing more.
    const ended: AgentJournalStatusItem | null =
      note === null ? null : { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    const stopNoteWrite = ended !== null ? (requestNoteWrite ?? writeNote(ended)) : undefined
    input.endSession?.({
      waitsForProvider: taken === true,
      stoppedAt,
      stopNote: noteIdentity,
      stopNoteWrite,
      settled: closeSettle
    })
    cancelled = true
    note = ended
  } else if (runningCommand && !cancelled) {
    const noteWrite =
      requestNoteWrite ?? writeNote({ kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED })
    await input.stopChild?.()
    await noteWrite
    cancelled = true
    note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
  } else if (
    !cancelled &&
    interruptFailed &&
    input.stopChild &&
    // An unnamed Stop meant the turn the journal showed when it was sent.
    stillRunsStoppedTurn(ctx, stoppedTurnId)
  ) {
    // The interrupt failed and the turn runs on: only the child's end stops it.
    let ended: boolean
    const noteWrite =
      requestNoteWrite ?? writeNote({ kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED })
    try {
      await input.stopChild()
      ended = true
    } catch (error) {
      input.onStopChildError?.(error)
      // Unless the exit was proven, the child may still run the turn and the failed row stays true.
      ended = input.childReleased?.() === true
    }
    if (ended) {
      cancelled = true
      note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    } else if (taken !== undefined) {
      // The turn was just read running, so a named Stop says it was refused rather than nothing.
      note = stopRefusedNote(ctx, refusal)
    }
    await noteWrite
  } else if (!cancelled && taken === false && input.turnId !== undefined) {
    // Nothing was left of the turn it named and nothing else ended: a Stop that ends nothing writes no row.
    note = null
  }
  if (cancelled) {
    binding.turnId = stoppedTurn ?? stoppedTurnId ?? undefined
  } else if (interruptFailed) {
    // A Stop that failed reads "Stopping…" through the turn it could not stop; its end stays its own.
    binding.failedOn = structuredAgentSessionFailedStopMark(ctx.journal)
  }
  if (taken === true && stoppedTurn !== undefined && !binding.closedByWindDown && !input.scope) {
    await settleTakenStop(ctx, stoppedTurn)
  }
  const value = { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled }
  if (input.scope || note === null) {
    return { ok: true, value }
  }
  await (!noteWritten || note.text !== STOP_NOTE_CANCELLATION_REQUESTED
    ? writeNote(note)
    : requestNoteWrite)
  return { ok: true, value }
}
