import { randomUUID } from 'node:crypto'
import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { semanticWorkRecordId } from '../../../shared/agent-session-semantic-work'
import type { AgentSessionSemanticWork } from '../../../shared/agent-session-semantic-work'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { ChildWorkChange } from './structured-agent-session-open-child-work'
import type { StructuredAgentSessionChildWorkProducer } from './structured-agent-session-subagent-rows'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkAdmission } from './structured-agent-session-event-sink'

export type ChildWorkAdmission = StructuredAgentSessionSinkAdmission & {
  retry?: () => ChildWorkAdmission
}

/** One already accepted owner edge; a restart's old cut and new invocation commit together. */
export function acceptedChildWork(
  changes: ChildWorkChange[],
  producer?: StructuredAgentSessionChildWorkProducer,
  capture?: { journal: AgentSessionJournal; scope: () => AgentJournalTurnScope },
  onPublished?: () => void
): () => ChildWorkAdmission {
  for (const { token } of changes) {
    if (!token.journalWork && producer) {
      token.journalWork = { producer }
    }
  }
  const writer = producer ?? changes[0]?.token.journalWork?.producer
  const journal = capture?.journal ?? writer?.journalItems?.()
  let frontier: string | null = journal?.requestFrontier() ?? null
  let scope = capture?.scope() ?? AGENT_JOURNAL_THREAD_SCOPE
  const originalBytes = Buffer.byteLength(
    JSON.stringify([frontier, scope, changes.map(({ token }) => token.journalWork?.turnScope)]),
    'utf8'
  )
  let captureFailure: unknown
  const captured = journal?.readInOrder(() => {
    frontier = journal.requestFrontier()
    scope = capture?.scope() ?? AGENT_JOURNAL_THREAD_SCOPE
    for (const { token } of changes) {
      if (token.journalWork) {
        token.journalWork.turnScope ??= scope
      }
    }
  })
  // Capture in issue order even if the original producer's reservation is temporarily full.
  void captured?.catch((error: unknown) => {
    captureFailure = error
  })
  return acceptedWorkTransition(
    writer,
    changes.map(({ token, start, phase }) => ({
      source: {
        kind: 'child',
        invocationId: token.invocationId,
        idKind: start.child.handle.idKind,
        handleId: start.child.handle.id,
        runId: start.child.handle.runId,
        ownerId: start.child.ownerId
      },
      startedAt: start.observedAt,
      phase
    })),
    () => {
      if (captureFailure) {
        throw captureFailure
      }
      if (!journal) {
        throw new Error('accepted child work has no ordered source capture')
      }
      return { frontier, scopes: changes.map(({ token }) => token.journalWork?.turnScope ?? scope) }
    },
    onPublished,
    originalBytes
  )
}

type WorkEdge = Omit<AgentSessionSemanticWork, 'kind' | 'version' | 'afterRequest'>

/** The reversible provider-held state of an existing accepted submission, not a delivery ACK. */
export function acceptedSubmissionWork(
  journal: AgentSessionJournal,
  changes: readonly { clientMessageId: string; held: boolean }[],
  producer: StructuredAgentSessionChildWorkProducer,
  onPublished: () => void
): () => ChildWorkAdmission {
  const edges = changes.flatMap(({ clientMessageId, held }): WorkEdge[] => {
    const source = journal.submission(clientMessageId)
    return source
      ? [
          {
            source: { kind: 'submission', clientMessageId },
            startedAt: source.submittedAt,
            phase: held ? 'open' : 'settled'
          }
        ]
      : []
  })
  return acceptedWorkTransition(
    producer,
    edges,
    () => ({ frontier: null, scopes: edges.map(() => AGENT_JOURNAL_THREAD_SCOPE) }),
    onPublished
  )
}

function acceptedWorkTransition(
  writer: StructuredAgentSessionChildWorkProducer | undefined,
  edges: WorkEdge[],
  captured: () => { frontier: string | null; scopes: AgentJournalTurnScope[] },
  onPublished?: () => void,
  originalBytes = 0
): () => ChildWorkAdmission {
  const settlementId = randomUUID()
  const retry = (): ChildWorkAdmission => {
    if (!writer) {
      if (edges.length) {
        return { accepted: false, reason: 'closed' }
      }
      onPublished?.()
      return { accepted: true }
    }
    // Raw source occurs in both the body and the legacy record identity, including JSON escaping.
    const reservedBytes =
      Buffer.byteLength(JSON.stringify(edges), 'utf8') * 3 +
      edges.length * (2 * 16384 * 6 + originalBytes + 2048)
    const admission = writer.tryAppendTransition?.({
      lifecycle: edges.length > 0,
      publish: true,
      onPublished,
      steps: edges.length
        ? [
            {
              kind: 'settlement',
              settlementId,
              reservedBytes,
              resolve: (actual) => {
                const { frontier, scopes } = captured()
                const items = new Map<string, JournalLifecycleMutationInput>()
                for (const [index, edge] of edges.entries()) {
                  const body: AgentSessionSemanticWork = {
                    kind: 'semantic-work',
                    version: 1,
                    ...edge,
                    ...(edge.phase === 'interrupted' ? { afterRequest: frontier } : {})
                  }
                  const recordId = semanticWorkRecordId(body.source)
                  items.set(recordId, {
                    kind: 'item',
                    identity: {
                      provider: 'legacy',
                      agent: actual.agent,
                      sessionId: actual.sessionId,
                      recordId
                    },
                    body,
                    turnScope: scopes[index]
                  })
                }
                return [...items.values()]
              }
            }
          ]
        : []
    }) ?? { accepted: false, reason: 'closed' }
    return admission.accepted ? admission : { ...admission, retry }
  }
  return retry
}

/** Off-frame/teardown use of the same producer: one real drain, then a truthful finite result. */
export async function finishChildWorkAdmission(
  admission: ChildWorkAdmission | void,
  producer: StructuredAgentSessionChildWorkProducer | undefined
): Promise<StructuredAgentSessionSinkBarrier> {
  try {
    if (
      admission &&
      !admission.accepted &&
      admission.reason === 'backpressure' &&
      admission.retry
    ) {
      const drained = await producer?.written?.()
      if (drained && !drained.ok) {
        return drained
      }
      admission = admission.retry()
    }
    if (admission && !admission.accepted) {
      return { ok: false, error: new Error(`child work was not admitted (${admission.reason})`) }
    }
    return (await producer?.written?.()) ?? { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}
