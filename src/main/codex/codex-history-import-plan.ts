import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  codexItemIdentity,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  continuedOutsideRecordId,
  createHistoryCatchUpBatch
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  codexRestoreFits,
  CODEX_RESTORE_MAX_BYTES
} from './codex-structured-journal-translation-restore'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

/** Invocation-local shared translation: nothing reaches the live sink until this plan is whole. */
export function createCodexHistoryImportPlan(input: {
  sessionId: string
  threadId: string
  journal: StructuredAgentSessionTransitionJournal
  nativePromptKeys: ReadonlySet<string>
  outsideNotice?: AgentJournalItemBody
  check: () => void
}) {
  const batch = createHistoryCatchUpBatch()
  const encoded = new Map<string, string>()
  const turnIds: string[] = []
  const receipts: { clientMessageId: string; providerIdentity: AgentJournalItemIdentity }[] = []
  let receiptBytes = 0
  const confirmReceipts = (turn: Record<string, unknown>) => {
    input.check()
    if (!codexRestoreFits([turn], receipts.length + batch.size)) {
      throw new Error('too-large')
    }
    if (typeof turn.id !== 'string') {
      return
    }
    const ordinals = new CodexTurnOrdinals()
    for (const value of Array.isArray(turn.items) ? turn.items : []) {
      const item = readCodexThreadItem(value)
      if (!item) {
        continue
      }
      const providerIdentity = codexItemIdentity({
        threadId: input.threadId,
        turnId: turn.id,
        item,
        ordinals,
        historyImport: true
      })
      if (
        item.type === 'userMessage' &&
        typeof item.clientId === 'string' &&
        input.nativePromptKeys.has(agentJournalSubmissionKey(item.clientId))
      ) {
        const receipt = { clientMessageId: item.clientId, providerIdentity }
        receiptBytes += Buffer.byteLength(JSON.stringify(receipt), 'utf8')
        if (receiptBytes > CODEX_RESTORE_MAX_BYTES) {
          throw new Error('too-large')
        }
        receipts.push(receipt)
      }
    }
  }
  let outsideNoted = false
  let omitted = new Map<string, string>()
  const append = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    input.check()
    const key = agentJournalItemKey(identity)
    if (omitted.has(key)) {
      return { accepted: true } as const
    }
    // The saved relation is display-only: name the original prompt without accepting its send.
    if (body.kind === 'turn' && body.userItemId) {
      const nativePrompt = omitted.get(body.userItemId)
      if (nativePrompt !== undefined) {
        body = { ...body, userItemId: nativePrompt }
      }
    }
    const mutation = {
      ...journalLifecycleItemMutation(options, identity, body),
      ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
    }
    const serialized = JSON.stringify(mutation)
    const previous = encoded.get(key)
    if (previous !== undefined) {
      if (previous !== serialized) {
        throw new Error('conflicting-history-identity')
      }
      return { accepted: true } as const
    }
    batch.push(mutation, serialized)
    encoded.set(key, serialized)
    return { accepted: true } as const
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: append,
    tryAppendItem: append,
    appendTombstone: () => {
      throw new Error('unexpected-history-tombstone')
    },
    publish: () => {},
    tryPublish: () => ({ accepted: true }),
    tryReviseResolvedItem: (_reserved, resolve, options) => {
      const item = resolve(input.journal)
      return item ? append(item.identity, item.body, options) : { accepted: true }
    }
  }
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: input.sessionId,
    primaryThreadId: () => input.threadId,
    historyImport: true
  })
  return {
    append,
    confirmReceipts,
    restore: (turn: Record<string, unknown>) => {
      input.check()
      if (typeof turn.id !== 'string') {
        throw new Error('invalid-turn')
      }
      confirmReceipts(turn)
      omitted = new Map<string, string>()
      const ordinals = new CodexTurnOrdinals()
      let native = false
      let outsideUser = false
      for (const value of Array.isArray(turn.items) ? turn.items : []) {
        const item = readCodexThreadItem(value)
        if (!item) {
          continue
        }
        const identity = codexItemIdentity({
          threadId: input.threadId,
          turnId: typeof turn.id === 'string' ? turn.id : null,
          item,
          ordinals,
          historyImport: true
        })
        if (item.type === 'userMessage') {
          if (
            typeof item.clientId === 'string' &&
            item.clientId.length > 0 &&
            input.nativePromptKeys.has(agentJournalSubmissionKey(item.clientId))
          ) {
            native = true
            omitted.set(agentJournalItemKey(identity), agentJournalSubmissionKey(item.clientId))
          } else {
            outsideUser = true
          }
        }
      }
      if ((!native || outsideUser) && !outsideNoted && input.outsideNotice) {
        append(
          {
            provider: 'legacy',
            agent: 'codex',
            sessionId: input.sessionId,
            recordId: continuedOutsideRecordId(turn.id)
          },
          input.outsideNotice,
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        outsideNoted = true
      }
      const restored = translator.restoreThread(input.threadId, { turns: [turn] })
      if (!restored.accepted) {
        throw new Error(restored.reason)
      }
      turnIds.push(turn.id)
    },
    finish: () => {
      input.check()
      const keys = [...encoded.keys()]
      const plan = batch.finish('codex-history-import', [
        input.journal.epoch,
        input.threadId,
        turnIds,
        keys,
        receipts
      ])
      return { ...plan, turnIds, receipts }
    },
    dispose: () => translator.dispose()
  }
}
