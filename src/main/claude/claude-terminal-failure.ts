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
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
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

function latestClosedWork(sink: StructuredAgentSessionEventSink): AgentJournalRenderItem | null {
  const journal = sink.journalItems?.()
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
export function resolveClaudeTerminalOwner(
  sink: StructuredAgentSessionEventSink,
  turn: ClaudeOpenTurn,
  frame: Record<string, unknown>
): { identity: AgentJournalItemIdentity | null; current: boolean } | null {
  const journal = sink.journalItems?.()
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
    return {
      identity: parseAgentJournalItemKey(owner.itemId),
      current: owner.itemId === (turn.identity && agentJournalItemKey(turn.identity))
    }
  }
  if (turn.identity) {
    return { identity: turn.identity, current: true }
  }
  if (turn.isReopenSuppressed && latestClosedWork(sink)) {
    return null
  }
  return { identity: null, current: false }
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
  revise.call(sink, reservedBytes, (journal) => {
    const old = journal.itemBody(agentJournalItemKey(failureIdentity))
    const prior = old?.kind === 'status' ? readAgentSessionFailureFact(old.failure) : undefined
    const next = body.kind === 'status' ? readAgentSessionFailureFact(body.failure) : undefined
    const merged = prior?.kind === 'usageLimitReached' && next?.kind === 'usageLimitReached'
      ? { ...body, ...agentSessionFailureWords({
          ...prior, ...next,
          usageLimit: next.usageLimit ?? prior.usageLimit,
          detail: providerDiagnostic(
            [...new Set([prior.detail?.text, next.detail?.text].filter(Boolean))].join('\n'), 'person'
          )
        }, { agentName: 'Claude', provider: 'claude', surface: 'row' }) }
      : body
    return JSON.stringify(merged) === JSON.stringify(old)
      ? null : { identity: failureIdentity, body: merged }
  }, options)
}

// Every ending reads its own quota fact after preceding assistant writes have landed.
export function finalizeClaudeTerminalTurn(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  write: AgentJournalTurnRowWrite,
  turn: ClaudeOpenTurn
): boolean {
  if (!sink.tryAppendTransition || !write.lifecycle) {
    return false
  }
  const lifecycle = write.lifecycle
  const target = { identity }
  const reservedBytes = agentJournalTurnRowReservedBytes(target, write)
  let failed = false
  sink.tryAppendTransition({
    lifecycle: true,
    publish: true,
    steps: [{
      kind: 'item', reservedBytes, options: { turnScope: { kind: 'thread' } },
      resolve: (journal) => {
        const itemId = agentJournalItemKey(identity)
        const row = journal.item(agentJournalItemKey(claudeTerminalFailureIdentity(itemId)))
        const quota = row?.body.kind === 'status' && isRootAgentJournalItem(row) &&
          row.turnScope?.kind === 'turn' && row.turnScope.turnItemId === itemId &&
          readAgentSessionFailureFact(row.body.failure)?.kind === 'usageLimitReached'
        const stopped = lifecycle.completedAt !== undefined &&
          sink.journalStopDecidesTurn?.(lifecycle.turnId, lifecycle.completedAt)
        const outcome = lifecycle.outcome ?? (quota ? (stopped ? 'cancellation' : 'failure') : undefined)
        failed = outcome === 'failure'
        return resolveAgentJournalTurnRowWrite(journal, target, {
          ...write, lifecycle: { ...lifecycle, ...(outcome ? { outcome } : {}) }
        }, reservedBytes)
      }
    }],
    onPublished: () => {
      const current = turn.identity
      if (
        failed && (!current || agentJournalItemKey(current) === agentJournalItemKey(identity)) &&
        latestClosedWork(sink)?.itemId === agentJournalItemKey(identity)
      ) {
        turn.suppressReopenOnFailure(true)
      }
    }
  })
  return true
}
