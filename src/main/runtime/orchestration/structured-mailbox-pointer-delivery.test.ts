import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { readMailHandoff } from './mail-handoff'
import type { StructuredMailEvidence } from './mailbox-settlement'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function harness() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'result' })
  const evidence: StructuredMailEvidence = {
    epoch: 'epoch',
    frontier: 'frontier',
    stopInForce: false,
    submission: undefined,
    owner: null,
    latestTurn: null,
    acceptedUnopened: false,
    personStopped: false,
    diedTurnId: null
  }
  const send = vi.fn<StructuredMailboxPointerHost['send']>(async (input) =>
    input.beforeRun()
      ? { kind: 'sent', state: 'accepted', clientMessageId: 'actual-submission' }
      : { kind: 'superseded' }
  )
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: 'session', dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host: {
      readSessionFacts: async () => ({ epoch: evidence.epoch, frontier: evidence.frontier }),
      readHandoffEvidence: async () => evidence,
      readHandoffEvidenceNow: () => evidence,
      hasActionablePromptNow: () => false,
      currentFence: () => 1,
      currentContextClearOperationId: () => undefined,
      send
    }
  })
  return { db, message, evidence, send, delivery }
}

it('a consuming read invalidates a reserved notice before final host admission', async () => {
  const { db, message, delivery, send } = harness()
  let admitted = false
  send.mockImplementation(async (input) => {
    db.recordUnknownMailRead([message])
    admitted = input.beforeRun()
    return { kind: 'superseded' }
  })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(admitted).toBe(false)
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
})

it('a late accepted receipt cannot overwrite a newer read or acknowledgement', async () => {
  const { db, message, delivery, send } = harness()
  send.mockImplementation(async (input) => {
    expect(input.beforeRun()).toBe(true)
    db.recordUnknownMailRead([message])
    const firstRead = db.getMessageById(message.id)!.handoff
    db.recordUnknownMailRead([message])
    expect(db.getMessageById(message.id)!.handoff).not.toBe(firstRead)
    db.markAsRead([message.id])
    return { kind: 'sent', state: 'accepted', clientMessageId: 'actual-submission' }
  })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(db.getMessageById(message.id)).toMatchObject({ read: 1 })
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
})

it('records the actual queue handover identity and retains its ordinary ownership', async () => {
  const { db, message, delivery, send } = harness()
  send.mockResolvedValue({ kind: 'queued', clientMessageId: 'queued-draft' })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() =>
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
      phase: 'offered',
      clientMessageId: 'queued-draft'
    })
  )
  delivery.onJournalActivity('session')
  await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
})
