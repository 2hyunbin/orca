import {
  writeMailHold,
  mailHoldsCommitted
} from '../native-chat/agent-session-journal/journal-mail-holds'
import type { AgentSessionReserveResult } from './agent-session-reservation-admission'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { commitAgentSessionFounding } from './agent-session-founding-admission'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { draftAgentSessionStoreState } from './agent-session-store-draft'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

/** Founding shares the store's admission and publishes only after the message transaction commits. */
export function createAgentSessionFoundingStore(
  transactions: AgentSessionStoreTransactions,
  firstRecordListeners: ReadonlySet<() => void>
) {
  const prepareReceipt = (request: AgentSessionReserveRequest, rejectReplay: boolean) => {
    let result: AgentSessionReserveResult | undefined
    let heldBefore = true
    let database: Parameters<JournalOperationReceipt['write']>[0] | undefined
    const recordReceipt = transactions.receipt((draft) => {
      heldBefore = draft.records.size > 0 || draft.unreadableRecords.size > 0
      result = commitAgentSessionFounding(draft, request)
      if (rejectReplay && result.disposition === 'replayed') {
        throw agentSessionRefusalError('agent_session_operation_unknown', {
          reason: 'outcomeUnknown'
        })
      }
    })
    const receipt: JournalOperationReceipt = {
      write: (db, row) => {
        recordReceipt.write(db, row)
        if (result?.disposition === 'created' && !request.adoptedHandleLink) {
          writeMailHold(db, request.sessionId, { version: 1, status: 'released' }, true)
          database = db
        }
      },
      committed: () => {
        if (database) {
          mailHoldsCommitted(database)
        }
        recordReceipt.committed()
        if (!heldBefore) {
          firstRecordListeners.forEach((listener) => listener())
        }
      }
    }
    return {
      receipt,
      result: () => {
        if (!result) {
          throw new Error('founding result missing')
        }
        return result
      }
    }
  }
  return {
    prepare: (request: AgentSessionReserveRequest) =>
      commitAgentSessionFounding(draftAgentSessionStoreState(transactions.state), request),
    commit: async (request: AgentSessionReserveRequest) => {
      const pending = prepareReceipt(request, false)
      await transactions.commitReceipt(pending.receipt)
      return pending.result()
    },
    receipt: (request: AgentSessionReserveRequest): JournalOperationReceipt =>
      prepareReceipt(request, true).receipt
  }
}
