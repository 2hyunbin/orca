import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type { JournalReducerState } from './journal-reducer'
import { resolveJournalItemId } from './journal-item-resolution'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'

export function createJournalSourceReads(state: () => JournalReducerState) {
  const submissions = (): AgentJournalSubmission[] => [...state().submissions.values()]
  return {
    visitItems: (
      visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
    ): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body)
      }
    },
    itemBody: (itemId: string): AgentJournalItemBody | null =>
      state().items.get(itemId)?.body ?? null,
    stoppedHistoryCarried: (): ReadonlyMap<string, readonly string[]> =>
      state().stoppedHistoryCarried,
    item: (itemId: string): AgentJournalRenderItem | null => state().items.get(itemId) ?? null,
    visitItemsWithLinkage: (visit: JournalItemLinkageVisitor): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body, item)
      }
    },
    lastActivityAt: (): number => state().lastActivityAt,
    itemFence: (itemId: string): number | undefined => journalItemExecutionFence(state(), itemId),
    itemProvenance: (itemId: string) => journalItemProvenance(state(), itemId),
    lastProviderActivityAt: (fence: number) => state().providerActivityAt.get(fence),
    submissionVersion: () => state().submissionVersion,
    submissions,
    historyOrigin: () => state().historyOrigin,
    submission: (clientMessageId: string) => state().submissions.get(clientMessageId),
    submissionAtItem: (itemId: string) => {
      const raw = state().selection.rawAt(itemId)
      return raw === undefined ? undefined : state().submissions.get(raw)
    },
    pendingSubmissions: () => submissions().filter((entry) => entry.dispatchState === 'pending'),
    receiptFor: (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
      state().receipts.get(clientMessageId) ?? null,
    canonicalItemId: (itemId: string): string => resolveJournalItemId(state(), itemId)
  }
}
