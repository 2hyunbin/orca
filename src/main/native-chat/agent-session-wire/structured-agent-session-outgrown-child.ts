// An idle child launched with another permission mode is replaced before the next send.

import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

/** What the check reads of a conversation; every read skips building a snapshot. */
type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<AgentSessionJournal, 'visitItems' | 'activeTurnId' | 'newestTurn'>
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

/** For a caller inside the session's serialize, before it hands the next send to
 *  the child. Work the child still owes keeps it, as it keeps an idle one from the sweep. A stop that fails
 *  leaves the close begun, which the start joins. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: {
    work: StructuredAgentSessionChildWorkReads
    /** The mode a start of the chat would launch with now. */
    launchPermission?: () => Promise<AgentChatPermissionMode | null>
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !(await launchedWithOtherPermissionMode(session.child, deps.launchPermission)) ||
    structuredAgentSessionChildHasOpenWork(session.journal, deps.work) ||
    owesWakeUp(session.journal, deps.work.childWork())
  ) {
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
