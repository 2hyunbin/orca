import type { ClaudeContextFacts } from './claude-context-facts'
import { claudeCommandResultEnd } from './claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { claudeFrameParentRef, isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from './claude-background-task-tracker'

export type ClaudeResultJournalContext = Pick<
  ClaudeMessageJournalContext,
  | 'sink'
  | 'streamedBlocks'
  | 'streamedText'
  | 'providerFallback'
  | 'corrections'
  | 'turn'
  | 'authenticationFailures'
  | 'threadGoal'
> & {
  prompts: ClaudeJournalPrompts
  context: ClaudeContextFacts
  goalBackgroundWork: () => ClaudeGoalBackgroundWork
}

export function journalClaudeResult(
  {
    sink,
    streamedBlocks,
    streamedText,
    providerFallback,
    corrections,
    turn,
    prompts,
    context,
    authenticationFailures,
    threadGoal,
    goalBackgroundWork
  }: ClaudeResultJournalContext,
  message: Record<string, unknown>,
  observedAt: number
): void {
  // Child results can report failures but must never settle the root turn.
  const settlesTurn = isRootClaudeFrame(message)
  const commandEnd = settlesTurn ? claudeCommandResultEnd(turn, sink, message, observedAt) : null
  if (commandEnd === 'another-input') {
    return
  }
  // Read before the settle below closes it: the result reports that turn's end.
  const endedTurnScope = turn.turnScope
  const endedTurnStartedAt = turn.startedAt
  // Read before the settle below closes the turn: an error end the journal's Stop rule makes a
  // person's cancellation is theirs to decide as the end is written (`turnEndAfterStop`).
  const turnId = settlesTurn ? turn.id : null
  const leftToStop = turnId !== null && sink.journalStopDecidesTurn?.(turnId, observedAt) === true
  if (settlesTurn) {
    prompts.retryPendingCancellations()
    turn.suppressReopenOnFailure(message.is_error === true)
    corrections.abandon()
    streamedText.finish({ completedAt: observedAt })
    context.settle(message, commandEnd ?? claudeTurnEndForResult(message, observedAt, leftToStop))
    // The turn is over. A block still awaiting its final keeps the text the
    // flush above journaled, but its live state goes: an interrupted turn
    // would otherwise retain that text for the life of the session.
    streamedBlocks.clear()
    streamedText.settle()
  }
  const goal = threadGoal.settle(
    message,
    {
      backgroundWork: goalBackgroundWork(),
      stoppedByPerson: leftToStop,
      turnStartedAt: endedTurnStartedAt
    },
    observedAt
  )
  if (goal) {
    sink.appendItem(goal.identity, goal.body, { turnScope: endedTurnScope })
    sink.publish()
  }
  const kind = claudeProviderFrameKind(message)
  const failure = claudeResultFailure(message, leftToStop)
  const alreadyShown = authenticationFailures.resultAlreadyShown(message)
  if ((failure || !isSettledClaudeResultKind(kind)) && !alreadyShown) {
    providerFallback.append(
      kind,
      message,
      failure?.text,
      undefined,
      { reportsFailure: failure !== null },
      settlesTurn
        ? () => ({ turnScope: endedTurnScope })
        : corrections.stampFor(claudeFrameParentRef(message))
    )
  }
}
