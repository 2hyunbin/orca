// A refused queued card comes back as a returned card that holds the queue even when every write
// of the card fails: the live hook, the drain's heal and the open-time repair. The card behind it
// never sends, Resume does not release it, and its own Send and Delete work.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  vi.useFakeTimers()
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    await rig.dispose()
  } finally {
    vi.useRealTimers()
  }
})

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** Lets the drain run its steps; none may hand a card off. */
async function expectNothingSent(...draftIds: string[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  for (const draftId of draftIds) {
    expect(await rig.handoff(draftId)).toBeUndefined()
  }
}

/** A and B wait behind a turn; A goes out and the agent refuses it while no card write lands. */
async function refusedWhileCardWritesFail(): Promise<{ first: string; second: string }> {
  const working = await rig.workingSend()
  const first = await queuedDraft('A')
  const second = await queuedDraft('B')
  await rig.settleAccepted(working, 'a')
  await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
  const refused = await rig.handoffId(first)
  const settle = JournalQueuedMessages.prototype.onRowInTransaction
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction').mockImplementation(function (
    this: JournalQueuedMessages,
    db,
    row
  ) {
    if (row.kind === 'dispatch' && row.clientMessageId === refused && row.state === 'rejected') {
      throw new Error('bookkeeping failed')
    }
    return settle.call(this, db, row)
  })
  vi.spyOn(JournalQueuedMessages.prototype, 'settleOwed').mockRejectedValue(new Error('heal'))
  vi.spyOn(JournalQueuedMessages.prototype, 'repairAndPrune').mockRejectedValue(new Error('repair'))
  await rig.settleRejected(refused, 'provider refused this payload')
  await eventually(async () =>
    expect(await rig.drafts()).toEqual([
      { messageId: first, state: 'returned' },
      { messageId: second, state: 'waiting' }
    ])
  )
  expectStoredAsHandedOff()
  return { first, second }
}

/** The injected failures held: the stored row still reads handed off, only the view returns it. */
function expectStoredAsHandedOff(): void {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  expect(journal?.queuedMessages.settlementOwed()).toBe(true)
}

it('holds the card behind it across a restart and a Resume, until it is deleted', async () => {
  const { first, second } = await refusedWhileCardWritesFail()
  const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  expect(page.ok && page.page.queuedMessages?.[0]?.returnedRejection).toMatchObject({
    kind: 'providerRejected'
  })
  await expectNothingSent(second)
  // Reopened with the card still stored as handed off: Resume lifts the restart's pause only.
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual([
    { messageId: first, state: 'returned' },
    { messageId: second, state: 'waiting' }
  ])
  expectStoredAsHandedOff()
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await expectNothingSent(second)
  expect(await rig.deleteQueued(first)).toMatchObject({ ok: true, value: { deleted: true } })
  await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
})

it('Send hands the refused card off again under a fresh id, ahead of the card behind it', async () => {
  const { first, second } = await refusedWhileCardWritesFail()
  const refused = await rig.handoffId(first)
  const resent = await rig.sendNow(first)
  if (!resent.ok || !('submission' in resent.value)) {
    throw new Error('expected the submission arm')
  }
  expect(resent.value.submission).toMatchObject({ queuedMessageId: first })
  expect(resent.value.submission.clientMessageId).not.toBe(refused)
  await expectNothingSent(second)
  await rig.settleAccepted(resent.value.submission.clientMessageId, 'a-again')
  await eventually(async () => expect(await rig.handoff(second)).toBeDefined())
})
