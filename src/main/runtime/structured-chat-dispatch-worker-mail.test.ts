import { mailHandoffFixture, observeMailSql } from './orchestration/mail-handoff.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { encodeAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import { createStructuredWorkerSessionForWorktree } from './rpc/methods/orchestration/worker/worker-topology'
import {
  sendStructuredWorkerPreamble,
  releaseStructuredWorkerSession,
  subscribeForRedrive
} from './rpc/methods/orchestration-structured-worker-session'
import { attachParams } from './structured-chat-coordinator-fake-codex-fixture'
import { sealedChildEnv } from './structured-session-child-env.test-support'
import { dispatchTaskSource } from './orchestration/dispatch-task-source'
import { StructuredAgentSessionLeaseRenewer } from '../native-chat/agent-session-wire/structured-agent-session-lease-renewer'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { readMailHandoff } from './orchestration/mail-handoff'
import './rpc/unused-default-rpc-methods.test-fixture'
// Worker mail belongs to its Dispatch mailbox; held pointers redrive on the next idle edge, including after restart or clear.

vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
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

async function openWorkerMailbox() {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  return { chat, mailbox: `dispatch:${idOf(dispatch)}` }
}

it.each([
  [100, 0],
  [1000, 0],
  [100, 1],
  [1000, 1],
  [100, 100],
  [1000, 1000]
])(
  'bounds actual canonical debt and lease/journal work at N=%i, own issued=%i',
  async (history, ownDebt) => {
    const { chat, mailbox } = await openWorkerMailbox()
    expect(await sendUserMessage(PEER_CHAT, 'working')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    const notify = (id: string) =>
      chat.handlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', id, text: id }
      })
    const own = host.deps.store.getRecord(PEER_CHAT)!
    const ids = Array.from(
      { length: 2 * history },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    )
    host.deps.journalDatabase.transaction((sql) => {
      sql.prepare('DELETE FROM agent_session_mail_holds WHERE session_id = ?').run(PEER_CHAT)
      const insert = sql.prepare('INSERT INTO agent_session_records VALUES (?, ?)')
      for (const [index, sessionId] of ids.entries()) {
        const record = { ...own, sessionId, lease: { ...own.lease, sessionId } }
        const linked =
          index >= history && index + 1 < ids.length
            ? {
                ...record,
                conversationCommand: {
                  command: 'clear',
                  state: 'completed',
                  phase: 'committed',
                  operationId: `clear-${index}`,
                  callerKey: 'person',
                  replacementSessionId: ids[index + 1]
                } as const
              }
            : record
        insert.run(sessionId, JSON.stringify(encodeAgentSessionRecord(linked)))
      }
    })
    // Load the saved corpus without pretending the still-held fixture transports restarted.
    const live = [host.deps.store.getRecord(COORDINATOR)!, own]
    host.deps.store = AgentSessionRecordStore.open({
      journalDatabase: host.deps.journalDatabase,
      hostId: 'local'
    })
    for (const record of live) {
      await host.deps.store.transitionHandoff(record.sessionId, () => record)
    }
    const reference = (sessionId: string, address: string, held = false) =>
      JSON.stringify(
        mailHandoffFixture({
          sessionId,
          authority: address,
          epoch: 'uncertain-corpus',
          frontier: 'corpus',
          phase: held ? 'reserved' : 'offered',
          ...(held ? { nonAdmission: 'held' } : {})
        })
      )
    const update = db.db.prepare('UPDATE messages SET handoff = ? WHERE id = ?')
    for (let index = 0; index < history; index++) {
      const other = db.insertMessage({
        from: 'sender',
        to: 'other-recipient',
        subject: 'issued elsewhere'
      })
      update.run(reference('other', other.to_handle, index % 2 === 0), other.id)
      const tail = db.insertMessage({
        from: 'sender',
        to: mailbox,
        subject: `tail-${index}`,
        type: index % 2 ? 'heartbeat' : 'status'
      })
      update.run(reference(PEER_CHAT, mailbox, true), tail.id)
    }
    const owned: string[] = []
    for (let index = 0; index < ownDebt; index++) {
      const row = db.insertMessage({
        from: 'sender',
        to: index % 2 || index === 2 ? mailbox : 'former-address',
        subject: 'own exact issued'
      })
      update.run(reference(index === 2 ? 'former-session' : PEER_CHAT, row.to_handle), row.id)
      owned.push(row.id)
    }
    const malformed = db.insertMessage({ from: 'sender', to: mailbox, subject: 'malformed' })
    update.run('{bad json', malformed.id)
    db.db
      .prepare("UPDATE messages SET delivery_contract = 'legacy_direct' WHERE id = ?")
      .run(owned[0] ?? malformed.id)
    db.db.exec('DROP INDEX idx_messages_issued_session; DROP INDEX idx_messages_issued_address')
    db.createMailboxDeliveryIndexesIfPossible()
    const sql = observeMailSql(
      db.db,
      /INDEXED BY idx_messages_issued_/,
      'all',
      ({ sql: query, args, rows }) => {
        expect(rows.length).toBeLessThanOrEqual(ownDebt)
        expect(sql.explain(query, args)).toContain(
          'SEARCH messages USING INDEX idx_messages_issued_'
        )
        expect(sql.explain(query, args, 'opcode')).toContain('SeekGE')
        expect(sql.explain(query, args, 'opcode')).not.toContain('Rewind')
      }
    )
    expect(
      db
        .getIssuedSessionMail([PEER_CHAT], [mailbox])
        .map((row) => row.id)
        .sort()
    ).toEqual(owned.sort())
    sql.trace.mockRestore()
    await call(
      'orchestration.send',
      { to: mailbox, subject: 'fresh report' },
      { sessionId: COORDINATOR }
    )
    await observationClock.observe(350)
    expect(host.readMailHandoffEvidenceNow(PEER_CHAT, '')?.mailHold?.ambiguous).toBe(true)
    const dispose = await subscribeForRedrive(host, PEER_CHAT, (id) =>
      runtime.notifyStructuredSessionJournalActivity(id)
    )
    const snapshots = vi.spyOn(host, 'journalSnapshot')
    const candidates = vi.spyOn(db, 'getAutomaticMailCandidates')
    const sends = vi.spyOn(host, 'send')
    const authority = vi.spyOn(db, 'mailboxHandoffAuthority')
    const receipts = vi.spyOn(host.deps.store, 'readCommandReceipt')
    const records = vi.spyOn(host.deps.store, 'listRecords')
    const debt = vi.spyOn(db, 'getIssuedSessionMail')
    try {
      const lineage = host.deps.store.lineageRevision
      const broad = host.deps.store.recordsRevision
      const renewer = new StructuredAgentSessionLeaseRenewer({
        store: host.deps.store,
        probe: async () => ({ outcome: 'indeterminate', reason: 'fixture' }),
        holdsLiveChild: () => true,
        now: () => Date.now() + 10_000,
        logger: createStructuredAgentSessionLogger()
      })
      await renewer.renewNow()
      expect(host.deps.store.recordsRevision).toBeGreaterThan(broad)
      expect(host.deps.store.lineageRevision).toBe(lineage)
      expect(records).toHaveBeenCalledOnce() // Producer's own population scan, separate from admission.
      records.mockClear()
      for (let batch = 0; batch < 3; batch++) {
        notify(`batch-${batch}`)
        await host.flushStreamedEvents(PEER_CHAT)
        await observationClock.observe(350)
      }
      expect(snapshots).not.toHaveBeenCalled()
      expect(candidates).not.toHaveBeenCalled()
      expect(sends).not.toHaveBeenCalled()
      expect(records).not.toHaveBeenCalled()
      expect(debt).toHaveBeenCalled()
      expect(
        debt.mock.results.every(
          (result) => result.type === 'return' && result.value.length === ownDebt
        )
      ).toBe(true)
      expect(receipts.mock.calls.length).toBeLessThanOrEqual(12 * ownDebt)
      expect(authority.mock.calls.length).toBeLessThanOrEqual(12 * ownDebt)
      expect(chat.turns).toHaveLength(1)
      expect(
        await sendUserMessage(PEER_CHAT, 'release legacy mail', 'queue-if-active')
      ).toMatchObject({ ok: true })
      expect(host.readMailHandoffEvidenceNow(PEER_CHAT, '')?.mailHold?.ambiguous).toBe(false)
      expect(chat.turns).toHaveLength(1)
      expect(candidates).not.toHaveBeenCalled()
      await settleTurn(PEER_CHAT, 0)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
      expect(turnText(chat.turns[1]!)).toBe('release legacy mail')
      await settleTurn(PEER_CHAT, 1)
      await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
      expect(turnText(chat.turns[2]!)).toContain('tail-0')
      expect(sends).toHaveBeenCalledTimes(2) // One person Send and one automatic report.
      await settleTurn(PEER_CHAT, 2)
    } finally {
      dispose()
    }
    db.markAsRead(owned)
    const remaining = new Set(db.getIssuedSessionMail([PEER_CHAT], [mailbox]).map((row) => row.id))
    expect(owned.some((id) => remaining.has(id))).toBe(false)
  }
)

it('autonomously redrives an excluded Dispatch report when its waiter aborts without consuming or changing SQL', async () => {
  const { chat, mailbox } = await openWorkerMailbox()
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

it('creates an acquired worker at the production topology owner, completes its automatic task and receives a full follow-up without personal release', async () => {
  await openChat(COORDINATOR)
  const { taskId } = await coordinatorRunAndTask()
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(async (args) =>
    attachParams(args.envelope.sessionId)
  )
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
    await host.setSessionTabVisibility(input.sessionId, true)
  })
  const acquire = host.deps.adapter.acquire.bind(host.deps.adapter)
  const spawned = vi.spyOn(host.deps.adapter, 'acquire').mockImplementation(async (input) => {
    expect(sealedChildEnv(input.identity.sessionId).ORCA_TERMINAL_HANDLE).toMatch(/^structworker_/)
    expect(host.deps.store.getRecord(input.identity.sessionId)?.lease.runtimeFence).toBe(
      input.fence
    )
    return acquire(input)
  })
  const created = await createStructuredWorkerSessionForWorktree({
    runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId: started.dispatch.id,
    effects: []
  })
  const { identity } = created
  try {
    expect(spawned).toHaveBeenCalledOnce()
    expect(host.readMailHandoffEvidenceNow(identity.sessionId, '')?.mailHold?.ambiguous).toBe(false)
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: identity.handle,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      worktreeId: 'workspace-1',
      effects: [],
      setupState: 'not_applicable'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    const preamble = sendStructuredWorkerPreamble({
      host,
      sessionId: identity.sessionId,
      dispatchId: started.dispatch.id,
      preamble: 'automatic first task',
      from: dispatchTaskSource({
        db,
        dispatch: started.dispatch,
        from: `orca_session_id:${COORDINATOR}`,
        senderName: () => null
      })
    })
    const chat = connectionFor(identity.sessionId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0, 'completed')
    expect(await preamble).toBe('accepted')
    expect(host.readMailHandoffEvidenceNow(identity.sessionId, '')?.mailHold?.ambiguous).toBe(false)
    for (const [index, address] of [identity.handle, `dispatch:${started.dispatch.id}`].entries()) {
      await call(
        'orchestration.send',
        { to: address, subject: `follow-up-${index}` },
        { sessionId: COORDINATOR }
      )
      await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 2), WAIT)
      expect(turnText(chat.turns[index + 1]!)).toContain(`follow-up-${index}`)
      expect(turnText(chat.turns[index + 1]!)).toMatch(MAIL)
      await settleTurn(identity.sessionId, index + 1, 'completed')
    }
  } finally {
    releaseStructuredWorkerSession(started.dispatch.id)
  }
})

it.each(['delayed', 'waiter', 'unrelated'] as const)(
  'validates omitted older heads at the committed claim after %s during a newer head await',
  async (change) => {
    const { chat: peer, mailbox } = await openWorkerMailbox()
    const turns = () => peer.turns
    const ownRun = await call(
      'orchestration.runCreate',
      { objective: 'peer' },
      { sessionId: PEER_CHAT }
    )
    const direct = `orca_session_id:${PEER_CHAT}`
    const abort = new AbortController()
    const waiting =
      change === 'waiter' || change === 'unrelated'
        ? runtime.waitForMessage(direct, { typeFilter: ['status'], signal: abort.signal })
        : null
    if (!waiting) {
      await sendUserMessage(PEER_CHAT, 'work before Stop')
      await vi.waitFor(() => expect(turns()).toHaveLength(1), WAIT)
    }
    const report = async (to: string, subject: string) => {
      if (change === 'delayed') {
        const sent = await call('orchestration.send', { to, subject }, { sessionId: COORDINATOR })
        return db.getMessageById(idOf(sent.message))!
      }
      return db.insertMessage({ from: 'coordinator', to, subject })
    }
    const older = await report(direct, 'older A')
    const newer = await report(`run:${idOf(ownRun.run)}`, 'newer B')
    const newest = await report(mailbox, 'newest Dispatch')
    let reached = false,
      reads = 0
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>()
    const original = host.readMailHandoffEvidence.bind(host)
    const reader = vi.spyOn(host, 'readMailHandoffEvidence').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (++reads === 1) {
        reached = true
        await barrier
      }
      return value
    })
    const settled = change === 'delayed' ? settleTurn(PEER_CHAT, 0, 'completed') : undefined
    if (change !== 'delayed') {
      runtime.deliverPendingMessagesForHandle(newest.to_handle)
    }
    await vi.waitFor(() => expect(reached).toBe(true), WAIT)
    if (change === 'waiter') {
      abort.abort()
      expect(await waiting).toBe('cancelled')
    }
    for (let index = 0; index < 3; index++) {
      db.insertMessage({ from: 'other', to: 'unrelated', subject: String(index) })
      db.insertMessage({ from: 'other', to: newer.to_handle, subject: `later-${index}` })
    }
    const claims = vi.spyOn(db, 'claimMailHandoff')
    release()
    await settled
    const offset = Number(!waiting)
    await vi.waitFor(() => expect(turns()).toHaveLength(offset + 1), WAIT)
    expect(turnText(turns()[offset]!)).toContain(change === 'unrelated' ? 'newer B' : 'older A')
    expect(db.db.isTransaction).toBe(false)
    expect(db.getMessageById(older.id)?.recovery_used).toBe(0)
    if (change === 'unrelated') {
      expect(claims).toHaveBeenCalledTimes(1)
      abort.abort()
      await waiting
    }
    await settleTurn(PEER_CHAT, connectionFor(PEER_CHAT).turns.length - 1, 'completed')
    await vi.waitFor(() => expect(turns()).toHaveLength(offset + 2), WAIT)
    expect(turnText(turns()[offset + 1]!)).toContain(change === 'unrelated' ? 'older A' : 'newer B')
    await settleTurn(PEER_CHAT, connectionFor(PEER_CHAT).turns.length - 1, 'completed')
    await vi.waitFor(() => expect(turns()).toHaveLength(offset + 3), WAIT)
    expect(turnText(turns()[offset + 2]!)).toContain('newest Dispatch')
    await settleTurn(PEER_CHAT, connectionFor(PEER_CHAT).turns.length - 1, 'completed')
    reader.mockRestore()
  }
)
