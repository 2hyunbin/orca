import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { freshAgentSessionMailReceipt } from './agent-session-founding-store'

/** Serializes a mutation and publishes listeners only after its record/receipt commit. */
export async function transactAgentSessionRecords<T>(
  transactions: AgentSessionStoreTransactions,
  deathEvidenceListeners: ReadonlySet<(sessionId: string) => void>,
  firstRecordListeners: ReadonlySet<() => void>,
  apply: (draft: AgentSessionStoreState) => T,
  options?: { inMemoryWhenReadOnly?: boolean },
  freshRoot?: { sessionId: string; created: (result: T) => boolean }
): Promise<T> {
  const holdsRecords = () =>
    transactions.state.records.size > 0 || transactions.state.unreadableRecords.size > 0
  let proven: string[] = []
  let heldBefore = true
  const applyObserved = (draft: AgentSessionStoreState): T => {
    heldBefore = holdsRecords()
    if (deathEvidenceListeners.size === 0) {
      return apply(draft)
    }
    const before = new Map(
      [...draft.records].map(([id, record]) => [id, record.lease.deathEvidence])
    )
    const applied = apply(draft)
    proven = [...draft.records]
      .filter(([id, { lease }]) => lease.deathEvidence && lease.deathEvidence !== before.get(id))
      .map(([id]) => id)
    return applied
  }
  let result: T
  if (freshRoot) {
    let accepted: { value: T } | undefined
    let created = false
    const receipt = transactions.receipt((draft) => {
      const absent =
        !draft.records.has(freshRoot.sessionId) && !draft.unreadableRecords.has(freshRoot.sessionId)
      accepted = { value: applyObserved(draft) }
      created = absent && freshRoot.created(accepted.value)
    })
    await transactions.commitReceipt(
      freshAgentSessionMailReceipt(receipt, freshRoot.sessionId, () => created)
    )
    if (!accepted) {
      throw new Error('reservation result missing')
    }
    result = accepted.value
  } else {
    result = await transactions.transact(applyObserved, options)
  }
  for (const sessionId of proven) {
    deathEvidenceListeners.forEach((listener) => listener(sessionId))
  }
  if (!heldBefore && holdsRecords()) {
    firstRecordListeners.forEach((listener) => listener())
  }
  return result
}
