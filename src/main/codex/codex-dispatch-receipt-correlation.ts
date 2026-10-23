import type {
  AgentJournalItemIdentity,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256
export const MAX_CODEX_RECORDED_TURN_ENDS = 64

export type CodexExpectedDispatchReceipt = {
  threadId: string
  via: AgentJournalTurnJoin
  key: string | null
}

function compareKey(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null
  }
  let text = ''
  let images = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      text += item.text
    }
    if (item.type === 'image' || item.type === 'localImage') {
      images++
    }
  }
  return JSON.stringify([text, images])
}

/** Live correlation shares the dispatch entries; it never infers delivery from a missing item. */
export function createCodexDispatchReceiptCorrelation(
  armed: ReadonlyMap<
    string,
    {
      expected?: CodexExpectedDispatchReceipt
      turn?: { threadId: string; turnId: string; via: AgentJournalTurnJoin }
    }
  >
) {
  const receipts = new Map<string, Extract<AgentJournalItemIdentity, { provider: 'codex' }>>()
  const seenReceipts = new Map<string, string | null>()
  const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId])
  return {
    expect: (
      id: string,
      threadId: string,
      via: AgentJournalTurnJoin,
      input: readonly Record<string, unknown>[]
    ) => {
      const entry = armed.get(id)
      if (entry) {
        entry.expected = { threadId, via, key: compareKey(input) }
      }
    },
    receipt: (
      identity: Extract<AgentJournalItemIdentity, { provider: 'codex' }>,
      content: unknown
    ) => {
      const key = JSON.stringify(identity)
      if (seenReceipts.has(key)) {
        return seenReceipts.get(key) ?? null
      }
      seenReceipts.set(key, null)
      if (seenReceipts.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
        seenReceipts.delete(seenReceipts.keys().next().value ?? '')
      }
      const opener = [...armed].find(
        ([, entry]) =>
          entry.turn?.threadId === identity.threadId &&
          entry.turn.turnId === identity.turnId &&
          entry.turn.via === 'start'
      )
      if (opener) {
        seenReceipts.set(key, opener[0])
        return opener[0]
      }
      if (
        [...armed.values()].some(
          (entry) =>
            entry.expected?.threadId === identity.threadId &&
            entry.expected.via === 'start' &&
            !entry.turn
        )
      ) {
        receipts.set(turnKey(identity.threadId, identity.turnId), identity)
        if (receipts.size > MAX_CODEX_RECORDED_TURN_ENDS) {
          receipts.delete(receipts.keys().next().value ?? '')
        }
        return null
      }
      const steer = [...armed].find(
        ([, entry]) =>
          entry.expected?.threadId === identity.threadId && entry.expected.via === 'steer'
      )
      const keyOfContent = compareKey(content)
      const id =
        steer && keyOfContent !== null && steer[1].expected?.key === keyOfContent ? steer[0] : null
      seenReceipts.set(key, id)
      return id
    },
    take: (id: string, threadId: string, turnId: string) => {
      const key = turnKey(threadId, turnId)
      const receipt = receipts.get(key) ?? null
      receipts.delete(key)
      if (receipt) {
        seenReceipts.set(JSON.stringify(receipt), id)
      }
      return receipt
    },
    clear: () => {
      receipts.clear()
      seenReceipts.clear()
    }
  }
}
