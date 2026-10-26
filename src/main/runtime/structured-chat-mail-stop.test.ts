import { selectStructuredMailHandoff } from './orchestration/mailbox-settlement'
import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  codex,
  runtime,
  db,
  host,
  observationClock,
  call,
  openChat,
  connectionFor,
  settleTurn,
  startTurn,
  envelope,
  sendUserMessage,
  finishWorker,
  coordinatorRunAndTask,
  WAIT,
  turnText,
  queuedCardTexts
} from './structured-chat-coordinator-mail-rig.test-fixture'
vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))
const edgesAnswered = (): Promise<void> => observationClock.edgesAnswered(runtime, WAIT)

it.each([
  [true, 'send', true],
  [true, 'resume', true],
  [false, 'resume', true],
  [false, 'resume', false]
] as const)(
  'keeps stopped obligations and personal queue held while fresh mail runs (card=%s, %s)',
  async (card, release, failWake) => {
    const chat = await openChat(COORDINATOR)
    const turns = () =>
      codex.connections.filter((c) => c.threadId === chat.threadId).flatMap((c) => c.turns)
    const { runId, taskId } = await coordinatorRunAndTask()
    await sendUserMessage(COORDINATOR, 'personal work')
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await startTurn(COORDINATOR, 0, 'personal work')
    if (card) {
      expect(
        await sendUserMessage(COORDINATOR, 'personal queued', 'queue-if-active')
      ).toMatchObject({ ok: true })
    }
    await finishWorker(taskId)
    const facts = await host.readMailHandoffEvidence(COORDINATOR, '')
    if (!facts) {
      throw new Error('missing journal')
    }
    const held = await selectStructuredMailHandoff({
      db,
      mailbox: `run:${runId}`,
      sessionId: COORDINATOR,
      epoch: facts.epoch,
      frontier: facts.frontier,
      waiters: undefined,
      reservedTypes: undefined,
      readEvidence: (r) => host.readMailHandoffEvidenceNow(r.sessionId, r.clientMessageId),
      limit: 1
    })
    expect(held?.reference.nonAdmission).toBe('held')
    const unreserved = db.insertMessage({
      from: 'term_worker',
      to: `run:${runId}`,
      runId,
      subject: 'unreserved B'
    })
    expect(db.getMessageById(unreserved.id)?.handoff).toBeNull()
    expect(
      await host.cancel(
        { callerKey: 'test-surface' },
        {
          envelope: envelope(COORDINATOR, 'agentSession.cancel', { turnId: 'turn-1' }),
          turnId: 'turn-1'
        }
      )
    ).toMatchObject({ ok: true })
    chat.handlers.onNotification?.('turn/completed', {
      turn: { id: 'turn-1', status: 'interrupted' }
    })
    await host.flushStreamedEvents(COORDINATOR)
    await edgesAnswered()
    expect(turns()).toHaveLength(1)
    if (card) {
      expect(await queuedCardTexts()).toEqual(['personal queued'])
    }
    await call('orchestration.send', {
      from: 'term_worker',
      to: `run:${runId}`,
      subject: 'fresh after Stop'
    })
    await vi.waitFor(() => expect(turns()).toHaveLength(2), WAIT)
    expect(turnText(turns()[1]!)).toContain('fresh after Stop')
    const retried = card && release === 'resume'
    if (retried) {
      await settleTurn(COORDINATOR, connectionFor(COORDINATOR).turns.length - 1, 'failed')
      await vi.waitFor(() => expect(turns()).toHaveLength(3), WAIT)
      await settleTurn(COORDINATOR, connectionFor(COORDINATOR).turns.length - 1, 'failed')
      await edgesAnswered()
      expect(turns()).toHaveLength(3)
      const fresh = db
        .getUnreadMessages(`run:${runId}`)
        .find((row) => row.subject === 'fresh after Stop')!
      expect(fresh.recovery_used).toBe(1)
      expect(
        (await call('orchestration.inbox', { id: fresh.id }, { sessionId: COORDINATOR })).messages
      ).toHaveLength(1)
      expect(db.getMessageById(unreserved.id)?.read).toBe(0)
    } else {
      await settleTurn(COORDINATOR, connectionFor(COORDINATOR).turns.length - 1, 'completed')
      await edgesAnswered()
      expect(turns()).toHaveLength(2)
    }
    const journal = host.collaboratorsForTests().sessions.get(COORDINATOR)!.journal
    expect(journal.queuedMessages.userStopInForce()).not.toBeNull()
    if (card) {
      expect(await queuedCardTexts()).toEqual(['personal queued'])
    }
    const mailFailure = failWake
      ? vi.spyOn(runtime, 'notifyStructuredSessionJournalActivity').mockImplementationOnce(() => {
          throw new Error('mail bookkeeping unavailable')
        })
      : undefined
    if (release === 'send') {
      expect(await sendUserMessage(COORDINATOR, 'continue personally')).toMatchObject({
        ok: true
      })
    } else {
      const status = host.readStatusSummary(COORDINATOR)
      expect(
        await host.queuedMessagesResume(
          { callerKey: 'test-surface' },
          { envelope: envelope(COORDINATOR, 'agentSession.queuedMessagesResume', {}) }
        )
      ).toMatchObject({ ok: true, value: { resumed: true } })
      if (!card) {
        expect(host.readStatusSummary(COORDINATOR)).toEqual({
          ...status,
          updatedAt: expect.any(Number)
        })
      }
    }
    if (mailFailure) {
      expect(mailFailure).toHaveBeenCalled()
      mailFailure.mockRestore()
      runtime.notifyStructuredSessionJournalActivity(COORDINATOR)
    }
    for (
      let index = 2 + Number(retried);
      index < 4 + Number(card) + Number(release === 'send') + Number(retried);
      index++
    ) {
      await vi.waitFor(() => expect(turns().length).toBeGreaterThan(index), WAIT)
      await settleTurn(COORDINATOR, connectionFor(COORDINATOR).turns.length - 1, 'completed')
    }
    expect(
      turns()
        .map(turnText)
        .filter((text) => text.includes('**Subject:** Done'))
    ).toHaveLength(1)
    expect(await queuedCardTexts()).toEqual([])
    expect(journal.queuedMessages.userStopInForce()).toBeNull()
  }
)
