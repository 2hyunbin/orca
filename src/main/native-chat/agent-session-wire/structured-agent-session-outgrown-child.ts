// Replace outgrown launch construction before user input; work the process owns keeps its child.

import {
  agentSessionFailureFact,
  readWholeAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'

export async function rejectBlockedStructuredAgentSessionTransition(
  deps: {
    retireOutgrownChild: (
      sessionId: string,
      next: AgentJournalSubmission
    ) => Promise<AgentSessionRefusalReference | void>
    sessions: ReadonlyMap<string, Pick<StructuredAgentSessionHostSession, 'journal'>>
    conversationFence: (sessionId: string) => number
    failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  },
  sessionId: string,
  next: AgentJournalSubmission
): Promise<boolean> {
  const refusal = await deps.retireOutgrownChild(sessionId, next)
  if (!refusal) {
    return false
  }
  await deps.sessions.get(sessionId)?.journal.resolveDispatch({
    clientMessageId: next.clientMessageId,
    state: 'rejected',
    fence: deps.conversationFence(sessionId),
    ...agentSessionFailureWords(agentSessionFailureFact('restartFailed', { refusal }), {
      ...deps.failureTextContext(sessionId),
      surface: 'rejection'
    })
  })
  return true
}

/** What the check reads of a conversation; every read skips building a snapshot. */
type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<
    AgentSessionJournal,
    'visitItemsWithLinkage' | 'itemFence' | 'newestTurn' | 'itemBody'
  > & {
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** The running child itself said it is not signed in through a rejected send or a row it wrote.
 *  Its fence scopes both to this child, so a new one has nothing. */
export function structuredAgentSessionChildReportedSignedOut(
  session: OutgrownChildReading
): boolean {
  const { child, journal } = session
  if (!child || child.phase === 'starting' || child.close) {
    return false
  }
  if (
    journal
      .submissions()
      .some(
        (submission) =>
          submission.dispatchState === 'rejected' &&
          submission.fence === child.fence &&
          signedOut(submission.rejection)
      )
  ) {
    return true
  }
  // The session's own agent only: a subagent's sign-in failure says nothing about its parent.
  let found = false
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    found ||=
      body.kind === 'status' &&
      isRootAgentJournalItem(attribution) &&
      signedOut(body.failure) &&
      journal.itemFence(itemId) === child.fence
  })
  return found
}

/** Child work that settled after the lead's newest turn ended: the lead may still owe the turn
 *  that reads its result, which journals nothing until it opens. The idle sweep's window covers
 *  this; a restart before the next send has none, so it waits for that turn. */
function owesWakeUp(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
  const ended = journal.newestTurn()?.completedAt
  return (childWork ?? []).some(
    (work) => work.settledAt !== undefined && (ended === undefined || work.settledAt > ended)
  )
}

/** Loop-free: a start launches with the same `current` this compares against. */
async function launchedWithOtherPermissionMode(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentChatPermissionMode | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.permissionMode || !current) {
    return false
  }
  const mode = await current()
  return mode !== null && mode !== child.permissionMode
}

/** For a caller inside the session's serialize, before it hands the next send to the child. Work
 *  the child still owes keeps it, as it keeps an idle one from the sweep. A stop that fails leaves
 *  the close begun, which the start joins. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: {
    /** `childWork`: the records, read only for endings the lead has yet to answer. */
    work: StructuredAgentSessionChildWorkReads & {
      childWork: () => readonly AgentChildWorkView[] | undefined
    }
    /** The mode a start of the chat would launch with now. */
    launchPermission?: () => Promise<AgentChatPermissionMode | null>
    next?: AgentJournalSubmission
    requiresModelTransitionRestart?: (next: AgentJournalSubmission) => boolean
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<AgentSessionRefusalReference | void> {
  if (!session) {
    return
  }
  const body =
    deps.next && session.journal.itemBody(agentJournalSubmissionKey(deps.next.clientMessageId))
  if (body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice') {
    return
  }
  const otherReason =
    structuredAgentSessionChildReportedSignedOut(session) ||
    (await launchedWithOtherPermissionMode(session.child, deps.launchPermission))
  const modelTransition = deps.next && deps.requiresModelTransitionRestart?.(deps.next) === true
  if (!otherReason && !modelTransition) {
    return
  }
  const wakeDebt = owesWakeUp(session.journal, deps.work.childWork())
  if (
    structuredAgentSessionChildHasOpenWork(
      modelTransition && !otherReason ? { ...deps.work, hasOpenDispatch: () => false } : deps.work
    ) ||
    wakeDebt
  ) {
    return modelTransition
      ? {
          code: 'agent_session_operation_invalid',
          details: {
            reason:
              deps.work.childWorkOpen() || wakeDebt ? 'backgroundTasksRunning' : 'messagesUnsettled'
          }
        }
      : undefined
  }
  if (!session.child || session.child.phase === 'starting' || session.child.close) {
    return
  }
  await deps.stopAgent(sessionId).catch((error: unknown) =>
    deps.logger.warn('replacing an outgrown agent failed', {
      scope: 'outgrown-child',
      sessionId,
      error
    })
  )
}
