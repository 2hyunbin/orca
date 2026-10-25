import { readMailHandoff } from './orchestration/mail-handoff'
import './rpc/unused-default-rpc-methods.test-fixture'
// A chat worker's coordinator mail lands in its Dispatch's mailbox. When the pointer to it was held
// (the provider died before taking it), the chat's next idle edge points it again, after a restart
// or in the same chat after /clear, as it does for a chat's own mail.

vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { subscribeForRedrive } from './rpc/methods/orchestration-structured-worker-session'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  MAIL,
  call,
  clearChat,
  codex,
  connectionFor,
  coordinatorRunAndTask,
  db,
  host,
  observationClock,
  openChat,
  restartRuntime,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

async function idleEdges(sessionId: string): Promise<void> {
  runtime.onStructuredSessionStatusForMail({ sessionId, status: null })
  runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
  await observationClock.observe(400)
  await host.flushStreamedEvents(sessionId)
}

/** Coordinator mail to the peer chat's Dispatch, its pointer lost with the provider. */
async function heldDispatchMail(): Promise<string> {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  await call('orchestration.send', { to: mailbox, subject: 'more' }, { sessionId: COORDINATOR })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(turnText(chat.turns[0]!)).toMatch(MAIL)
  chat.handlers.onExit?.(new Error('provider died before the echo'))
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(1)
  const unread = db.getUnreadMessages(mailbox)
  expect(unread).toHaveLength(1)
  expect(readMailHandoff(unread[0]!.handoff)).toMatchObject({
    phase: 'offered',
    manifest: { members: [unread[0]!.id] }
  })
  expect(unread[0]!.read).toBe(0)
  return mailbox
}

/** The chat's next turn, the person's; resolves to the session's provider once its edges ran. */
async function nextTurn(sessionId: string): Promise<{ turns: { text: string }[] }> {
  const before = codex.connections.length
  expect(await sendUserMessage(sessionId, 'again')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
  const revived = connectionFor(sessionId)
  await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
  await settleTurn(sessionId, 0)
  await idleEdges(sessionId)
  return revived
}

describe('uncertain Dispatch mail remains readable across context changes', () => {
  // Also covered by the restored-mail repoint a restart schedules; this pins the end result.
  it('after a restart', async () => {
    observationClock.start()
    const mailbox = await heldDispatchMail()
    restartRuntime()

    const revived = await nextTurn(PEER_CHAT)

    expect(revived.turns).toHaveLength(1)
    const checked = await call(
      'orchestration.check',
      { terminal: WORKER },
      { sessionId: PEER_CHAT }
    )
    expect(checked).toMatchObject({ count: 1 })
    expect(db.getUnreadMessages(mailbox)).toHaveLength(1)
  })

  it('in the same chat after /clear', async () => {
    observationClock.start()
    const mailbox = await heldDispatchMail()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)

    const revived = await nextTurn(cleared)

    expect(revived.turns).toHaveLength(1)
    const checked = await call(
      'orchestration.check',
      { terminal: WORKER },
      { sessionId: PEER_CHAT }
    )
    expect(checked).toMatchObject({ count: 1 })
    expect(db.getUnreadMessages(mailbox)).toHaveLength(1)
  })
})

it.each([100, 1000])(
  'busy worker journal batches do no repeated history, SQL selection or send work at %s retained items',
  async (history) => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const { dispatch } = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    const mailbox = `dispatch:${idOf(dispatch)}`
    expect(await sendUserMessage(PEER_CHAT, 'working')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    const notify = (id: string) =>
      chat.handlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', id, text: id }
      })
    for (let index = 0; index < history; index++) {
      notify(`history-${index}`)
      if (index % 100 === 99) {
        await host.flushStreamedEvents(PEER_CHAT)
      }
    }
    await host.flushStreamedEvents(PEER_CHAT)
    await call(
      'orchestration.send',
      { to: mailbox, subject: 'held report' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(
      () => expect(db.getUnreadMessages(mailbox)[0]?.handoff).toContain('held'),
      WAIT
    )
    const dispose = await subscribeForRedrive(host, PEER_CHAT, (id) =>
      runtime.notifyStructuredSessionJournalActivity(id)
    )
    const snapshots = vi.spyOn(host, 'journalSnapshot')
    const candidates = vi.spyOn(db, 'getAutomaticMailCandidates')
    const sends = vi.spyOn(host, 'send')
    const authority = vi.spyOn(db, 'mailboxHandoffAuthority')
    const receipts = vi.spyOn(host.deps.store, 'readCommandReceipt')
    try {
      for (let batch = 0; batch < 3; batch++) {
        notify(`batch-${batch}`)
        await host.flushStreamedEvents(PEER_CHAT)
        await observationClock.observe(350)
      }
      expect(snapshots).not.toHaveBeenCalled()
      expect(candidates).not.toHaveBeenCalled()
      expect(sends).not.toHaveBeenCalled()
      expect(authority).not.toHaveBeenCalled()
      expect(receipts).not.toHaveBeenCalled()
      expect(chat.turns).toHaveLength(1)
      await settleTurn(PEER_CHAT, 0)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      expect(turnText(chat.turns[1]!)).toContain('held report')
      await settleTurn(PEER_CHAT, 1)
    } finally {
      dispose()
    }
  }
)

it('autonomously redrives an excluded Dispatch report when its waiter aborts without consuming or changing SQL', async () => {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  const mailbox = `dispatch:${idOf(dispatch)}`
  const abort = new AbortController()
  const waiting = runtime.waitForMessage(mailbox, { typeFilter: ['status'], signal: abort.signal })
  const report = db.insertMessage({
    from: 'coordinator',
    to: mailbox,
    subject: 'excluded report',
    type: 'status'
  })
  await idleEdges(PEER_CHAT)
  expect(chat.turns).toHaveLength(0)
  expect(db.getMessageById(report.id)?.read).toBe(0)
  const changes = db.db.prepare('SELECT total_changes() AS n').get()?.n
  abort.abort()
  expect(await waiting).toBe('cancelled')
  expect(db.db.prepare('SELECT total_changes() AS n').get()?.n).toBe(changes)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(turnText(chat.turns[0]!)).toContain('excluded report')
  await settleTurn(PEER_CHAT, 0)
})
