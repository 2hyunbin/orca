import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { selectStructuredMailHandoff } from './mailbox-settlement'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'

const OPERATION_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/

describe('structured pointer operation id', () => {
  it('mints ids the host will admit', () => {
    // Use host operation ids; orchestration msg_<hex> ids are refused before send.
    expect(mintAgentSessionOperationId(Date.now())).toMatch(OPERATION_ID_PATTERN)
  })
})

it('re-mints for a different batch of the same size', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const input = {
      db,
      mailbox: 'consumer',
      sessionId: 'session',
      epoch: 'epoch',
      frontier: 'frontier',
      waiters: undefined,
      reservedTypes: undefined,
      readEvidence: async () => ({
        epoch: 'epoch',
        frontier: 'frontier',
        stopInForce: false,
        submission: undefined,
        owner: null,
        personStopped: false,
        diedTurnId: null
      })
    }
    const firstMembers = ['first', 'second'].map((subject) =>
      db.insertMessage({ from: 'sender', to: input.mailbox, subject })
    )
    const first = await selectStructuredMailHandoff(input)
    expect(first?.messages.map((message) => message.id)).toEqual(firstMembers.map((row) => row.id))
    expect((await selectStructuredMailHandoff(input))?.reference.operationId).toBe(
      first?.reference.operationId
    )
    db.markAsRead(firstMembers.map((row) => row.id))
    const nextMembers = ['third', 'fourth'].map((subject) =>
      db.insertMessage({ from: 'sender', to: input.mailbox, subject })
    )
    const next = await selectStructuredMailHandoff(input)
    expect(next?.messages.map((message) => message.id)).toEqual(nextMembers.map((row) => row.id))
    expect(next?.reference.operationId).toMatch(OPERATION_ID_PATTERN)
    expect(next?.reference.operationId).not.toBe(first?.reference.operationId)
  } finally {
    db.close()
  }
})
