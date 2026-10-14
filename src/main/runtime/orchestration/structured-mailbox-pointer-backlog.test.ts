import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost,
  type StructuredPointerSendOutcome
} from './structured-mailbox-pointer-delivery'
import type { StructuredMailSubmission } from './structured-pointer-operation-id'
import { createStructuredMailboxPointerHost } from './structured-mailbox-pointer-host'
import { createQueuedMessageTestRig } from '../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

const MAILBOX = 'term_chat'
const WAIT = { timeout: 10_000 }

function lane(db: OrchestrationDb, host: StructuredMailboxPointerHost) {
  return new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: HOST_TEST_SESSION, dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
}

it('sends past fifty pending reports before any acceptance, and drains a queued backlog', async () => {
  for (const pending of [true, false]) {
    const db = new OrchestrationDb(':memory:')
    const submissions: StructuredMailSubmission[] = []
    const issued: string[] = []
    const settles: ((outcome: StructuredPointerSendOutcome) => void)[] = []
    const report = () => db.insertMessage({ from: 'term_worker', to: MAILBOX, subject: 'report' })
    try {
      const messages = Array.from({ length: 51 }, report)
      const delivery = lane(db, {
        readSessionFacts: async () => ({ submissions }),
        currentFence: () => 1,
        currentContextClearOperationId: () => undefined,
        send: (input) => {
          const source = input.body.from?.orchestration
          const messageId =
            source?.message === 'mail-notice' ? source.messages[0]?.messageId : undefined
          if (!messageId) {
            throw new Error('mail identity missing')
          }
          issued.push(messageId)
          submissions.push({
            clientMessageId: input.operationId,
            mailMessageId: messageId,
            dispatchState: 'pending',
            submittedAt: Date.now()
          })
          input.onAnswered?.()
          return pending
            ? new Promise((resolve) => settles.push(resolve))
            : Promise.resolve({ kind: 'queued' })
        }
      })
      delivery.deliverForHandle(MAILBOX)
      await vi.waitFor(() => expect(issued).toEqual(messages.map((message) => message.id)), WAIT)
      if (pending) {
        expect(db.getUnreadMessages(MAILBOX)).toHaveLength(51)
        settles.forEach((settle) => settle({ kind: 'sent', state: 'unknown' }))
        // Once the wait expires, durable pending submissions still cannot hide newer mail.
        const next = report()
        delivery.deliverForHandle(MAILBOX)
        await vi.waitFor(() => expect(issued.at(-1)).toBe(next.id), WAIT)
        expect(issued).toHaveLength(52)
        settles.at(-1)?.({ kind: 'sent', state: 'unknown' })
      } else {
        await vi.waitFor(() => expect(db.getUnreadMessages(MAILBOX)).toEqual([]), WAIT)
      }
    } finally {
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  }
})

it('recovers a durable queued receipt after host replacement without another full report', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HOST_TEST_NOW)
  const db = new OrchestrationDb(':memory:')
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    setStructuredAgentSessionHost(rig.host)
    await rig.workingSend()
    const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
    vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((provider) => {
      const declared = capabilities(provider)
      return declared ? { ...declared, steering: 'queue' } : null
    })
    const message = db.insertMessage({ from: 'term_worker', to: MAILBOX, subject: 'one report' })
    const mark = vi.spyOn(db, 'markAsRead').mockImplementationOnce(() => {
      throw new Error('interrupted receipt')
    })
    lane(db, createStructuredMailboxPointerHost()).deliverForHandle(MAILBOX)
    await vi.waitFor(() => expect(mark).toHaveBeenCalledOnce(), WAIT)
    expect(db.getMessageById(message.id)?.read).toBe(0)
    const cards = await rig.drafts()
    expect(cards).toHaveLength(1)
    expect((await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions).toHaveLength(1)
    await rig.restartHostProcess()
    setStructuredAgentSessionHost(rig.host)
    const transport = createStructuredMailboxPointerHost()
    const send = vi.spyOn(transport, 'send')
    lane(db, transport).deliverForHandle(MAILBOX)
    await vi.waitFor(() => expect(db.getMessageById(message.id)?.read).toBe(1), WAIT)
    expect(send).not.toHaveBeenCalled()
    expect(await rig.drafts()).toEqual(cards)
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
    db.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
