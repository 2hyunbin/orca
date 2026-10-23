// What the chat's Stop acts on, decided ONCE, on the session's lane, as it is accepted: the turn
// it is about, the provider child it reaches, and whether it withdraws what is queued. After the
// acceptance commits, only identity can exclude that target: work ending cannot undo the Stop.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { stopReachesUnrecordedWork } from './structured-agent-session-queued-stop'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionStoppedTurnId } from './structured-agent-session-turn-stop-notes'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'

/**
 * - `close`: joins the close an earlier stop began on the child, which takes no input.
 * - `starting`: ends a child's start that may never land; it takes no interrupt.
 * - `interrupt`: interrupts what the child runs, ending it when the interrupt fails.
 * - `withdraw`: no agent to reach; it only withdraws what is queued.
 */
export type ChatStopReach = 'close' | 'starting' | 'interrupt' | 'withdraw'

export type ChatStopTarget = {
  reach: ChatStopReach
  child: StructuredAgentSessionProviderChild | null
  /** The turn the Stop is about: the one it named, else the one live as it was accepted. */
  turnId: string | null
  turnScope: AgentJournalTurnScope
  named: boolean
  /** The turn its event names when the Stop named one; else, and for a Stop that ends the
   *  provider's session, which ends whatever runs, the turn live as the event is written. */
  eventTurnId: string | null
  /** Sends queued as it was captured: the lane it holds keeps them the ones it withdraws. */
  queued: boolean
  /** It writes a Stop event of its own; else it repeats the one in force, or only joins a close. */
  marks: boolean
}

/** Null: a late Stop, or one with nothing queued and nothing in flight, which is an accepted
 *  no-op. A Stop naming a turn that already ended withdraws nothing and interrupts nothing. */
export function captureChatStopTarget(
  ctx: AgentSessionTurnContext,
  input: {
    child: StructuredAgentSessionProviderChild | null
    turnId?: string
    endsSession: boolean
    stoppedPrePrompt?: boolean
    stoppedSend?: boolean
  }
): ChatStopTarget | null {
  const { child, turnId } = input
  const reached = stopReachesUnrecordedWork(ctx, turnId)
  if (reached === 'late') {
    return null
  }
  const queued = ctx.journal.submissions().some(isQueuedAgentJournalSubmission)
  const target = {
    child,
    turnId: structuredAgentSessionStoppedTurnId(
      contextStructuredAgentSessionCurrentWork(ctx),
      turnId
    ),
    named: turnId !== undefined,
    turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope(),
    eventTurnId: input.endsSession ? null : (turnId ?? null),
    queued
  }
  if (child?.close) {
    return { ...target, reach: 'close', marks: queued }
  }
  if (child?.phase === 'starting') {
    return { ...target, reach: 'starting', marks: true }
  }
  // An aborted send remains this Stop's work even after its rejected answer reaches the fold.
  if (!child || (turnId === undefined && !input.stoppedSend && !isMainAgentWorking(ctx))) {
    return queued || input.stoppedPrePrompt ? { ...target, reach: 'withdraw', marks: true } : null
  }
  // Repeating the Stop in force with nothing sent since writes no second event, so a card queued
  // between the presses sends normally, as after one Stop.
  return { ...target, reach: 'interrupt', marks: queued || reached === 'unrecorded' }
}
