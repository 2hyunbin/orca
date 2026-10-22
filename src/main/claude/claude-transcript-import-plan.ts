import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type { JournalLifecycleIdentityMutationInput } from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  HISTORY_CATCH_UP_MAX_OPERATIONS,
  type HistoryCatchUpPlan
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
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
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { createClaudeTranscriptItemReader } from './claude-transcript-item-reader'

/** An isolated projection of final source items, compared with saved historical content. */
export function createClaudeTranscriptImportPlan(input: {
  sessionId: string
  providerSessionId: string
  journal: StructuredAgentSessionTransitionJournal
  /** Whether the divider reads as rewound; null when the chat holds nothing for one to follow. */
  rewound: boolean | null
  check: () => void
}) {
  const mutations = new Map<string, JournalLifecycleIdentityMutationInput>()
  const { saved, scopeOf, promptScope, dependencies } = createClaudeTranscriptItemReader(
    input.journal
  )
  const aliases = new Map<string, AgentJournalItemIdentity>()
  let historicalScope: AgentJournalTurnScope | null = null
  let sourceObservedAt: number | undefined
  const matchSource = (identities: AgentJournalItemIdentity[]) => {
    const matches = identities.flatMap((identity) => {
      const item = saved(agentJournalItemKey(identity))
      return item ? [item] : []
    })
    if (new Set(matches.map((item) => item.itemId)).size > 1) {
      throw new Error('ambiguous-history-identity')
    }
    const item = matches[0]
    const identity = item ? parseAgentJournalItemKey(item.itemId) : identities[0]
    if (!identity) {
      throw new Error('unknown-history-identity')
    }
    for (const candidate of identities) {
      aliases.set(agentJournalItemKey(candidate), identity)
    }
    if (item) {
      const scope = scopeOf(item)
      historicalScope = scope.kind === 'unknown' ? null : scope
    }
  }
  const append = (
    rawIdentity: AgentJournalItemIdentity,
    projected: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    input.check()
    const identity = aliases.get(agentJournalItemKey(rawIdentity)) ?? rawIdentity
    const key = agentJournalItemKey(identity)
    const existing = saved(key)
    if (projected.kind === 'turn' && (existing || historicalScope)) {
      return { accepted: true } as const
    }
    let body = projected
    let turnScope =
      projected.kind === 'message' && projected.role === 'user'
        ? options.turnScope
        : (historicalScope ?? options.turnScope)
    if (existing) {
      if (body.kind === 'message' && body.role === 'user') {
        return { accepted: true } as const
      }
      turnScope = scopeOf(existing)
      if (body.kind === 'tool-call' && existing.body.kind === 'tool-call') {
        // A call alone cannot undo its saved result; result-only suffixes keep the call metadata.
        body =
          body.state === 'running'
            ? existing.body
            : { ...existing.body, ...body, name: existing.body.name, input: existing.body.input }
      }
      if (
        body.kind === 'message' &&
        body.role === 'reasoning' &&
        existing.body.kind === 'message'
      ) {
        body = { ...existing.body, ...body }
      }
      if (isDeepStrictEqual(existing.body, body)) {
        return { accepted: true } as const
      }
    }
    const observedAt = mutations.has(key) ? mutations.get(key)?.observedAt : sourceObservedAt
    mutations.set(key, {
      ...journalLifecycleItemMutation({ ...options, turnScope, observedAt }, identity, body),
      ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
    })
    if (mutations.size > HISTORY_CATCH_UP_MAX_OPERATIONS) {
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
      if (envelope?.role === 'assistant') {
        const source =
          envelope.messageId && typeof row.apiBlockIndex === 'number'
            ? {
                provider: 'claude' as const,
                sessionId: envelope.sessionId,
                uuid: claudeSourceBlockId(envelope.messageId, row.apiBlockIndex)
              }
            : null
        const thinking = envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')
        const frameIdentity = thinking
          ? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
          : claudeMessageIdentity(envelope)
        matchSource(source ? [source, frameIdentity] : [frameIdentity])
      }
      if (envelope) {
        for (const tool of claudeToolUses(envelope)) {
          matchSource([claudeToolIdentity(envelope.sessionId, tool.id)])
        }
        for (const part of envelope.content) {
          const result = claudeRecord(part)
          const toolUseId = result?.type === 'tool_result' ? claudeText(result.tool_use_id) : null
          if (toolUseId) {
            matchSource([claudeToolIdentity(envelope.sessionId, toolUseId)])
          }
        }
      }
      const parsedAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      sourceObservedAt = Number.isFinite(parsedAt) ? parsedAt : undefined
      lastAt = sourceObservedAt ?? lastAt
      const prompt =
        queued ||
        (envelope?.role === 'user' &&
          envelope.content.some((part) => claudeRecord(part)?.type !== 'tool_result'))
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
          ...(sourceObservedAt === undefined ? {} : { observedAt: sourceObservedAt })
        })
        return
      }
      // Folded input belongs to the ongoing turn; only a physical opener ends its predecessor.
      if (!queued) {
        idle(sourceObservedAt)
        historicalScope = null
      }
      const sourceUuid = queued ? claudeText(claudeRecord(row.attachment)?.source_uuid) : null
      const identity: AgentJournalItemIdentity = {
        provider: 'claude',
        sessionId: input.providerSessionId,
        uuid: sourceUuid ?? decoded.id
      }
      const existing = saved(agentJournalItemKey(identity))
      if (existing) {
        historicalScope = promptScope(existing, queued) ?? historicalScope
        return
      }
      const scope = historicalScope ?? translator.currentTurnScope()
      append(identity, legacyItemBody(decoded, LEGACY_IMPORT_BLOCK_LIMITS), {
        turnScope: queued
          ? scope.kind === 'turn'
            ? scope
            : { kind: 'unknown' }
          : AGENT_JOURNAL_THREAD_SCOPE
      })
      if (envelope && decoded.role === 'user') {
        translator.handle({
          type: 'message',
          sessionId: input.sessionId,
          message: frame,
          startsTurn: true,
          ...(sourceObservedAt === undefined ? {} : { observedAt: sourceObservedAt })
        })
      }
    },
    finish: (): HistoryCatchUpPlan | null => {
      input.check()
      if (uuids.length > 0) {
        idle(lastAt)
      }
      translator.flush()
      // A row that renders nothing (a thinking block saved without its text) adds no divider either.
      const rows = [...mutations.values()]
      const batch = createHistoryCatchUpBatch()
      const firstCreated = rows.find(
        (row) =>
          row.kind === 'item' &&
          row.body.kind !== 'turn' &&
          !dependencies.has(agentJournalItemKey(row.identity))
      )
      if (input.rewound !== null && firstCreated) {
        batch.push(
          journalLifecycleItemMutation(
            { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
            {
              provider: 'legacy',
              agent: 'claude',
              sessionId: input.sessionId,
              recordId: continuedOutsideRecordId(agentJournalItemKey(firstCreated.identity))
            },
            continuedOutsideNotice(input.rewound)
          )
        )
      }
      const revised = new Set<string>()
      for (const row of rows) {
        const key = agentJournalItemKey(row.identity)
        const existing = saved(key)
        if (existing && row.kind === 'item') {
          batch.revise(row, { canonicalItemId: existing.itemId, revision: existing.revision })
          revised.add(key)
        } else {
          batch.push(row)
        }
      }
      for (const [key, item] of dependencies) {
        if (!revised.has(key)) {
          batch.expectItem(key, { canonicalItemId: item.itemId, revision: item.revision })
        }
      }
      return batch.finish('claude-history-import', [
        input.journal.epoch,
        input.providerSessionId,
        uuids,
        rows
      ])
    },
    dispose: () => translator.dispose()
  }
}
