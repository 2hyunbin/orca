import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { readMailHandoff } from './orchestration/mail-handoff'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
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
    chat.handlers.onNotification?.('turn/started', {
      turn: { id: 'turn-1', status: 'inProgress' }
    })
    chat.handlers.onNotification?.('item/completed', {
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'personal-echo',
        clientId: chat.turns[0]!.clientUserMessageId,
        content: [{ type: 'text', text: 'personal work' }]
      }
    })
    await host.flushStreamedEvents(COORDINATOR)
    if (card) {
      expect(
        await sendUserMessage(COORDINATOR, 'personal queued', 'queue-if-active')
      ).toMatchObject({ ok: true })
    }
    await finishWorker(taskId)
    await vi.waitFor(
      () =>
        expect(readMailHandoff(db.getUnreadMessages(`run:${runId}`)[0]?.handoff)).toMatchObject({
          nonAdmission: 'held'
        }),
      WAIT
    )
    const unreserved = db.insertMessage({
      from: 'term_worker',
      to: `run:${runId}`,
      runId,
      subject: 'unreserved B'
    })
    expect(db.getMessageById(unreserved.id)?.handoff).toBeNull()
    const envelope = (method: string, fields: Record<string, unknown>) => ({
      sessionId: COORDINATOR,
      clientOperationId: operationId(),
      expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId: COORDINATOR,
        fields
      })
    })
    expect(
      await host.cancel(
        { callerKey: 'test-surface' },
        { envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }), turnId: 'turn-1' }
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
    await settleTurn(COORDINATOR, connectionFor(COORDINATOR).turns.length - 1, 'completed')
    await edgesAnswered()
    expect(turns()).toHaveLength(2)
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
          { envelope: envelope('agentSession.queuedMessagesResume', {}) }
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
    for (let index = 2; index < 4 + Number(card) + Number(release === 'send'); index++) {
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
