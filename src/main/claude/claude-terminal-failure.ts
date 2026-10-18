import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import { readAgentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { latestNativeChatTurnSinceRequest } from '../../shared/native-chat-orca-stop-cut'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite,
  type AgentJournalTurnRowWrite
} from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeText } from './claude-structured-item-translation'
import { claudeTurnLifecycleIdentity } from './claude-turn-lifecycle-item'

export function claudeTerminalFailureIdentity(turnItemId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `terminal-failure:claude:${turnItemId}` }
}

function latestClosedWork(
  journal: StructuredAgentSessionTransitionJournal | null | undefined
): AgentJournalRenderItem | null {
  if (!journal) {
    return null
  }
  const items: AgentJournalRenderItem[] = []
  journal.visitItemsWithLinkage((itemId) => {
    const item = journal.item(itemId)
    if (item) {
      items.push(item)
    }
  })
  items.sort((a, b) => a.sequence - b.sequence)
  return latestNativeChatTurnSinceRequest(items, journal.submissions())?.turnItem ?? null
}

// Historical correlation wins over a newer cursor; unknown accepted work keeps its diagnostic.
function resolveClaudeTerminalOwner(
  journal: StructuredAgentSessionTransitionJournal,
  suppressed: boolean,
  frame: Record<string, unknown>
): AgentJournalItemIdentity | null | undefined {
  const sessionId = claudeText(frame.session_id)
  const stamp = claudeText(frame.user_message_uuid)
  const uuid = stamp ?? (frame.type === 'assistant' ? claudeText(frame.uuid) : null)
  let owner: AgentJournalRenderItem | null = null
  if (journal && sessionId && uuid) {
    const candidate = journal.item(agentJournalItemKey(claudeTurnLifecycleIdentity(sessionId, uuid)))
    if (candidate?.body.kind === 'turn' && isRootAgentJournalItem(candidate)) {
      owner = candidate
    } else if (stamp) {
      const echo = journal.canonicalItemId(
        agentJournalItemKey({ provider: 'claude', sessionId, uuid: stamp })
      )
      journal.visitItemsWithLinkage((itemId, _sequence, body) => {
        const identity = parseAgentJournalItemKey(itemId)
        if (
          body.kind === 'turn' && body.userItemId && identity?.provider === 'legacy' &&
          identity.agent === 'claude' && identity.sessionId === sessionId &&
          journal.canonicalItemId(body.userItemId) === echo
        ) {
          const candidate = journal.item(itemId)
          if (candidate && isRootAgentJournalItem(candidate)) {
            owner = candidate
          }
        }
      })
    }
  }
  if (owner) {
    return parseAgentJournalItemKey(owner.itemId)
  }
  if (suppressed && latestClosedWork(journal)) {
    return null
  }
  return undefined
}

export function writeClaudeTerminalFailure(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): void {
  const turnItemId = agentJournalItemKey(identity)
  const failureIdentity = claudeTerminalFailureIdentity(turnItemId)
  const options = { turnScope: { kind: 'turn' as const, turnItemId } }
  const revise = sink.tryReviseResolvedItemAndPublish
  if (!revise) {
    sink.appendItem(failureIdentity, body, options)
    sink.publish()
    return
  }
  const reservedBytes = Buffer.byteLength(JSON.stringify({ failureIdentity, body }), 'utf8') + 8192
  revise.call(sink, reservedBytes, (journal) => mergeClaudeTerminalFailure(journal, identity, body), options)
}

function mergeClaudeTerminalFailure(
  journal: StructuredAgentSessionRevisionJournal,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
) {
  const failureIdentity = claudeTerminalFailureIdentity(agentJournalItemKey(identity))
  const old = journal.itemBody(agentJournalItemKey(failureIdentity))
  const prior = old?.kind === 'status' ? readAgentSessionFailureFact(old.failure) : undefined
  const next = body.kind === 'status' ? readAgentSessionFailureFact(body.failure) : undefined
  const previousDetail = prior?.detail?.text
  const incomingDetail = next?.detail?.text
  const detail = previousDetail && incomingDetail && !previousDetail.includes(incomingDetail)
    ? `${previousDetail}\n${incomingDetail}` : previousDetail ?? incomingDetail ?? ''
  const merged = prior?.kind === 'usageLimitReached' && next?.kind === 'usageLimitReached'
    ? { ...body, ...agentSessionFailureWords({
        ...prior, ...next,
        usageLimit: next.usageLimit ?? prior.usageLimit,
        detail: providerDiagnostic(detail, 'person')
      }, { agentName: 'Claude', provider: 'claude', surface: 'row' }) }
    : body
  return JSON.stringify(merged) === JSON.stringify(old)
    ? null : { identity: failureIdentity, body: merged }
}

// Cursor-less and positively different work wait for preceding ownership writes, never for a new cursor.
export function queueClaudeTerminalFailure(
  sink: StructuredAgentSessionEventSink,
  turn: ClaudeOpenTurn,
  frame: Record<string, unknown>,
  body: AgentJournalItemBody | null,
  fallback: () => void,
  completeUnowned?: () => void
): void {
  const generation = turn.generation
  const cursorless = !turn.isOpen
  const suppressed = turn.isReopenSuppressed
  let unowned = false
  const finish = (): void => {
    if (unowned) {
      fallback()
      if (cursorless && turn.generation === generation && frame.type === 'result') {
        completeUnowned?.()
      }
    }
  }
  if (!sink.tryAppendTransition) {
    unowned = true
    finish()
    return
  }
  sink.tryAppendTransition({
    lifecycle: true,
    publish: true,
    steps: [{
      kind: 'item',
      reservedBytes: Buffer.byteLength(JSON.stringify({ frame, body }), 'utf8') + 8192,
      options: { turnScope: { kind: 'thread' } },
      resolve: (journal) => {
        const identity = resolveClaudeTerminalOwner(journal, suppressed, frame)
        unowned = identity === undefined
        if (!identity || !body) {
          return null
        }
        const turnItemId = agentJournalItemKey(identity)
        const prior = journal.itemBody(agentJournalItemKey(claudeTerminalFailureIdentity(turnItemId)))
        if (frame.type === 'result' && !(prior?.kind === 'status' && prior.failure?.kind === 'usageLimitReached')) {
          return null
        }
        const merged = mergeClaudeTerminalFailure(journal, identity, body)
        return merged ? { ...merged, turnScope: { kind: 'turn', turnItemId } as const } : null
      }
    }],
    onPublished: finish
  })
}

// Every ending reads its own quota fact after preceding assistant writes have landed.
export function finalizeClaudeTerminalTurn(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  write: AgentJournalTurnRowWrite,
  turn: ClaudeOpenTurn
): boolean {
  const revise = sink.tryReviseResolvedItemAndPublish
  if (!revise || !write.lifecycle || write.lifecycle.outcome !== undefined) {
    return false
  }
  const lifecycle = write.lifecycle
  const target = { identity }
  const reservedBytes = agentJournalTurnRowReservedBytes(target, write)
  let failed = false
  revise.call(sink, reservedBytes, (journal) => {
    const itemId = agentJournalItemKey(identity)
    const row = journal.item(agentJournalItemKey(claudeTerminalFailureIdentity(itemId)))
    const quota = row?.body.kind === 'status' && isRootAgentJournalItem(row) &&
      row.turnScope?.kind === 'turn' && row.turnScope.turnItemId === itemId &&
      readAgentSessionFailureFact(row.body.failure)?.kind === 'usageLimitReached'
    const stopped = lifecycle.completedAt !== undefined &&
      sink.journalStopDecidesTurn?.(lifecycle.turnId, lifecycle.completedAt)
    const outcome = quota ? (stopped ? 'cancellation' : 'failure') : undefined
    failed = outcome === 'failure'
    return resolveAgentJournalTurnRowWrite(journal, target, {
      ...write, lifecycle: { ...lifecycle, ...(outcome ? { outcome } : {}) }
    }, reservedBytes)
  }, { turnScope: { kind: 'thread' } }, () => {
    const current = turn.identity
    if (
      failed && (!current || agentJournalItemKey(current) === agentJournalItemKey(identity)) &&
      latestClosedWork(sink.journalItems?.())?.itemId === agentJournalItemKey(identity)
    ) {
      turn.suppressReopenOnFailure(true)
    }
  })
  return true
}
