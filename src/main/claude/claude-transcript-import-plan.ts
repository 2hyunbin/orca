import { createHash } from 'node:crypto'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import {
  legacyItemBody,
  LEGACY_IMPORT_BLOCK_LIMITS
} from '../native-chat/agent-session-journal/journal-legacy-import'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { decodeClaudeTranscriptLine } from '../native-chat/transcript-line-decoders-claude'
import { claudeSourceBlockId } from './claude-streamed-block-identity'
import {
  claudeMessageIdentity,
  claudeRecord,
  claudeText,
  claudeThinkingIdentity,
  claudeToolIdentity,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

/** One batch's bounds, the same as an outside Codex batch's. */
const CLAUDE_IMPORT_MAX_OPERATIONS = 1_024
const CLAUDE_IMPORT_MAX_BYTES = 16 * 1024 * 1024

/** Every key a live chat could have written this transcript row under. */
function liveKeys(envelope: ClaudeMessageEnvelope, row: Record<string, unknown>): string[] {
  const { sessionId, uuid } = envelope
  const keys = [agentJournalItemKey(claudeMessageIdentity(envelope))]
  if (envelope.messageId && typeof row.apiBlockIndex === 'number') {
    const source = claudeSourceBlockId(envelope.messageId, row.apiBlockIndex)
    keys.push(agentJournalItemKey({ provider: 'claude', sessionId, uuid: source }))
  }
  keys.push(agentJournalItemKey(claudeThinkingIdentity(sessionId, uuid)))
  for (const tool of claudeToolUses(envelope)) {
    keys.push(agentJournalItemKey(claudeToolIdentity(sessionId, tool.id)))
  }
  for (const part of envelope.content) {
    const result = claudeRecord(part)
    const toolUseId = result?.type === 'tool_result' ? claudeText(result.tool_use_id) : null
    if (toolUseId) {
      keys.push(agentJournalItemKey(claudeToolIdentity(sessionId, toolUseId)))
    }
  }
  return keys
}

function isPrompt(envelope: ClaudeMessageEnvelope | null): boolean {
  return (
    envelope?.role === 'user' &&
    envelope.content.some((part) => claudeRecord(part)?.type !== 'tool_result')
  )
}

/**
 * The rows a chat lacks for transcript rows written outside it, through the live translator in a
 * sink of its own: nothing reaches the chat until the whole plan is admitted. The sink offers no
 * journal-reading revision, so a turn row lands as its lifecycle and no write revises a live row.
 */
export function createClaudeTranscriptImportPlan(input: {
  sessionId: string
  providerSessionId: string
  journal: StructuredAgentSessionTransitionJournal
  outsideNotice?: AgentJournalItemBody
  check: () => void
}) {
  const mutations = new Map<string, JournalLifecycleMutationInput>()
  let bytes = 0
  const append = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    input.check()
    const key = agentJournalItemKey(identity)
    const mutation = {
      ...journalLifecycleItemMutation(options, identity, body),
      // Display only: an outside prompt names no send of this chat's.
      ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
    }
    // A later write of a row replaces its body where the first one put it, as the journal does.
    bytes += Buffer.byteLength(JSON.stringify(mutation), 'utf8') + 1
    mutations.set(key, mutation)
    if (mutations.size > CLAUDE_IMPORT_MAX_OPERATIONS || bytes > CLAUDE_IMPORT_MAX_BYTES) {
      throw new Error('too-large')
    }
    return { accepted: true } as const
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: append,
    tryAppendItem: append,
    appendTombstone: () => {
      throw new Error('unexpected-history-tombstone')
    },
    publish: () => {},
    tryPublish: () => ({ accepted: true })
  }
  const translator = createClaudeJournalTranslator({
    sink,
    fallbackIdPrefix: `history:${input.providerSessionId}`
  })
  const known = (key: string) => input.journal.item(input.journal.canonicalItemId(key)) !== null
  const idle = (observedAt?: number) =>
    translator.handle({
      type: 'message',
      sessionId: input.sessionId,
      message: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: input.providerSessionId
      },
      ...(observedAt === undefined ? {} : { observedAt })
    })
  const uuids: string[] = []
  let lastAt: number | undefined
  return {
    restore: (row: Record<string, unknown>) => {
      input.check()
      const frame = { ...row, session_id: row.sessionId, parent_tool_use_id: null }
      const envelope = readClaudeMessageEnvelope(frame)
      const queued = row.type === 'attachment'
      // The tail reader keeps only rows that carry one.
      const uuid = String(row.uuid)
      if (!envelope && !queued) {
        return
      }
      const keys = envelope
        ? liveKeys(envelope, row)
        : [
            agentJournalItemKey({
              provider: 'claude',
              sessionId: input.providerSessionId,
              uuid
            })
          ]
      if (keys.some(known)) {
        return
      }
      const parsedAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      const observedAt = Number.isFinite(parsedAt) ? parsedAt : undefined
      lastAt = observedAt ?? lastAt
      const prompt = queued || isPrompt(envelope)
      const decoded = prompt
        ? decodeClaudeTranscriptLine(JSON.stringify(row), `${input.providerSessionId}:${uuid}`)
        : null
      // A stop marker restates the chat's own interrupted turn, which its turn row already reads.
      if (prompt && (!decoded || decoded.role === 'system')) {
        return
      }
      uuids.push(uuid)
      if (!decoded) {
        translator.handle({
          type: 'message',
          sessionId: input.sessionId,
          message: frame,
          ...(observedAt === undefined ? {} : { observedAt })
        })
        return
      }
      // A prompt ends the turn before it, which a transcript records no result for.
      idle(observedAt)
      const identity: AgentJournalItemIdentity = {
        provider: 'claude',
        sessionId: input.providerSessionId,
        uuid: decoded.id
      }
      append(identity, legacyItemBody(decoded, LEGACY_IMPORT_BLOCK_LIMITS), {
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      if (envelope && decoded.role === 'user') {
        translator.handle({
          type: 'message',
          sessionId: input.sessionId,
          message: frame,
          startsTurn: true,
          ...(observedAt === undefined ? {} : { observedAt })
        })
      }
    },
    finish: () => {
      input.check()
      if (uuids.length > 0) {
        idle(lastAt)
      }
      translator.flush()
      // A row that renders nothing (a thinking block saved without its text) adds no divider either.
      if (![...mutations.values()].some((m) => m.kind === 'item' && m.body.kind !== 'turn')) {
        mutations.clear()
      }
      const planned = [...mutations.values()]
      if (planned.length > 0 && input.outsideNotice) {
        const divider: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: 'claude',
          sessionId: input.sessionId,
          recordId: `continued-outside:${uuids[0]}`
        }
        planned.unshift(
          journalLifecycleItemMutation(
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
            divider,
            input.outsideNotice
          )
        )
        mutations.set(agentJournalItemKey(divider), planned[0])
      }
      const keys = [...mutations.keys()]
      const digest = createHash('sha256')
        .update(JSON.stringify([input.journal.epoch, input.providerSessionId, uuids, keys]))
        .digest('hex')
      const settlementId = `claude-history-import:${digest}`
      // Match the existing batch envelope charge, plus the transition's one publication byte.
      const reservedBytes =
        Buffer.byteLength(JSON.stringify({ settlementId, mutations: planned }), 'utf8') + 512
      if (reservedBytes + 1 > CLAUDE_IMPORT_MAX_BYTES) {
        throw new Error('too-large')
      }
      return { settlementId, mutations: planned, keys, reservedBytes }
    },
    dispose: () => translator.dispose()
  }
}
