import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { journalDispatchRowApplies } from '../native-chat/agent-session-journal/journal-dispatch-settlement'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type {
  CodexAcquisitionAttempt,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export function createCodexSessionJournalTranslator(input: {
  sink: StructuredAgentSessionEventSink | undefined
  account: () => AgentSessionAccountKind | undefined
  sessionId: string
  acquisitionId: string
  /** This generation's: a send handed over at another is not this child's to receipt. */
  fence: number
  journal: () => StructuredAgentSessionTransitionJournal | null
  deps: CodexStructuredSessionAdapterDeps
  primaryThreadId: () => string | null
  dispatchEchoes: CodexDispatchEchoes
  subagentExecutions: CodexSubagentExecutions
  prompts: CodexAcquisitionAttempt['window']['prompts']
}) {
  const { sink, account, sessionId, acquisitionId, deps, dispatchEchoes, prompts } = input
  return sink
    ? createCodexJournalTranslator({
        sink,
        account,
        sessionId,
        acquisitionId,
        ...(deps.now ? { now: deps.now } : {}),
        primaryThreadId: input.primaryThreadId,
        dispatchRequestOrigin: (clientMessageId) => dispatchEchoes.requestOrigin(clientMessageId),
        subagentExecutions: input.subagentExecutions,
        bindPromptItemId: (journalItemId, threadId, promptKey, turnId) =>
          prompts.bindJournalItemId(journalItemId, threadId, promptKey, turnId),
        clearPromptTurn: (threadId, turnId) => prompts.clearTurn(threadId, turnId),
        onUserMessageEcho: (clientMessageId, providerIdentity) => {
          // Codex no longer holds an echoed send, whether or not its receipt saves.
          const armed = dispatchEchoes.settle(clientMessageId)
          if (codexReceiptOwed(input.journal(), input.fence, clientMessageId, armed)) {
            deps.onDispatchSettledLate?.({ sessionId, clientMessageId, providerIdentity })
          }
        }
      })
    : null
}

/** The journal, not the armed entry, says whether an exact echo is still owed its receipt: so
 *  Codex's second echo of a send retries a failed save, and an echo after its release still counts. */
function codexReceiptOwed(
  journal: StructuredAgentSessionTransitionJournal | null,
  fence: number,
  clientMessageId: string,
  armed: boolean
): boolean {
  if (!journal?.submission) {
    // No bound journal to check (an unbound sink, or a test double): the armed entry admits it.
    return armed
  }
  const submission = journal.submission(clientMessageId)
  return (
    journalDispatchRowApplies(submission) &&
    submission?.handedOverAt !== undefined &&
    submission.fence === fence
  )
}
