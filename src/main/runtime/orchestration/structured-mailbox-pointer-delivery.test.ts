import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { mailHandoffFixture, observeMailSql } from './mail-handoff.test-fixture'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { selectStructuredMailHandoff, type StructuredMailEvidence } from './mailbox-settlement'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'

const roots: string[] = []
const databases: OrchestrationDb[] = []
const journalDatabases: JournalHostDatabase[] = []
const journals: AgentSessionJournal[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  journalDatabases.splice(0).forEach((db) => db.close())
  for (const db of databases.splice(0)) {
    db.close()
  }
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function harness(path = ':memory:') {
  const db = new OrchestrationDb(path)
  databases.push(db)
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'result' })
  const evidence: StructuredMailEvidence = {
    epoch: 'epoch',
    frontier: 'frontier',
    mailHold: { members: new Set(), ambiguous: false, key: 'released' },
    submission: undefined,
    owner: null,
    personStopped: false,
    diedTurnId: null
  }
  const send = vi.fn<StructuredMailboxPointerHost['send']>(async (input) =>
    input.beforeRun()
      ? { kind: 'sent', state: 'accepted', clientMessageId: 'actual-submission' }
      : { kind: 'superseded' }
  )
  const host: StructuredMailboxPointerHost = {
    readReceipt: () => ({ verdict: 'absent' }),
    readSessionFacts: async () => ({ epoch: evidence.epoch, frontier: evidence.frontier }),
    readHandoffEvidence: async () => evidence,
    readHandoffEvidenceNow: () => evidence,
    hasActionablePromptNow: () => false,
    currentFence: () => 1,
    currentContextClearOperationId: () => undefined,
    send
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: 'session', dispatchId: null }),
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
  return { db, message, evidence, send, delivery, host }
}

function queuedReceipt(reference: StructuredMailHandoff, clientMessageId: string) {
  return {
    verdict: 'readable' as const,
    receipt: {
      operationId: reference.operationId,
      sessionId: reference.sessionId,
      callerKey: 'caller',
      method: 'agentSession.send',
      fingerprint: 'exact',
      acceptedAt: 1,
      status: 'accepted' as const,
      result: { kind: 'queued-draft' as const, messageId: clientMessageId }
    }
  }
}

function issued(db: OrchestrationDb, ids: string[], patch: Partial<StructuredMailHandoff> = {}) {
  const reference = mailHandoffFixture({
    manifest: {
      members: ids,
      dispatchId: null,
      runtimeFence: 1,
      body: JSON.stringify({ kind: 'message', role: 'user', blocks: [] })
    },
    ...patch
  })
  for (const member of ids) {
    db.db
      .prepare('UPDATE messages SET handoff = ? WHERE id = ?')
      .run(JSON.stringify(reference), member)
  }
  return reference
}

it.each([10, 100].flatMap((count) => ['busy', 'idle', 'cohort'].map((mode) => ({ count, mode }))))(
  'bounds readable historical preparation and incomplete cohorts $mode at N=$count',
  async ({ count, mode }) => {
    const { db, message, evidence, host, send, delivery } = harness()
    db.markAsRead([message.id])
    const saved = new Map<string, string>()
    const sources = new Set(['session'])
    for (let i = 0; i < count; i++) {
      const row = db.insertMessage({ from: 'sender', to: 'consumer', subject: `old-${i}` })
      const victim =
        mode === 'cohort'
          ? db.insertMessage({ from: 'sender', to: 'consumer', subject: 'sibling' })
          : null
      const prior = `prior-${i}`
      const original = `original-${i}`
      const reference = issued(db, victim ? [row.id, victim.id] : [row.id], {
        sessionId: victim ? 'session' : prior,
        phase: victim ? 'reserved' : 'offered',
        recoverySource:
          mode === 'idle'
            ? { sessionId: original, epoch: 'epoch', clientMessageId: original }
            : undefined
      })
      if (victim) {
        db.recordUnknownMailRead([victim])
      } else {
        sources.add(prior)
        if (mode === 'idle') {
          sources.add(original)
        }
      }
      saved.set(row.id, JSON.stringify(reference))
    }
    evidence.mailHold = {
      members: new Set(),
      ambiguous: false,
      key: 'released',
      scope: { root: 'session', aliases: [...sources] }
    }
    const root = mkdtempSync(join(tmpdir(), 'pr28567-readable-sources-'))
    roots.push(root)
    const store = JournalHostDatabase.open(root)
    journalDatabases.push(store)
    const readers = new Map<string, AgentSessionJournal>()
    for (const sessionId of sources) {
      const journal = new AgentSessionJournal({
        database: store,
        mintEpoch: () => 'epoch',
        identity: {
          sessionId,
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'codex',
          providerHandle: null
        }
      })
      await journal.open()
      journals.push(journal)
      readers.set(sessionId, journal)
    }
    const costs = {
      inventory: 0,
      raw: 0,
      receipts: 0,
      candidates: 0,
      rows: 0,
      ordered: 0,
      storeRows: 0,
      members: 0
    }
    const sql = observeMailSql(
      db.db,
      /INDEXED BY idx_messages_(issued_|id)/,
      'all',
      ({ sql: query, args, rows }) => {
        if (query.includes('INDEXED BY idx_messages_id')) {
          costs.members += rows.length
          expect(sql.explain(query, args)).toContain('SEARCH messages USING INDEX idx_messages_id')
        } else {
          costs.raw += rows.length
        }
      }
    )
    const inventory = db.getIssuedSessionMail.bind(db)
    vi.spyOn(db, 'getIssuedSessionMail').mockImplementation((...args) => {
      costs.inventory++
      return inventory(...args)
    })
    const candidates = db.getAutomaticMailCandidates.bind(db)
    vi.spyOn(db, 'getAutomaticMailCandidates').mockImplementation((...args) => {
      const rows = candidates(...args)
      costs.candidates++
      costs.rows += rows.length
      return rows
    })
    host.readReceipt = () => {
      costs.receipts++
      return { verdict: 'absent' }
    }
    host.takesMailNow = () => mode !== 'busy'
    host.readHandoffEvidence = async ({ sessionId }) => {
      const journal = readers.get(sessionId)
      if (!journal) {
        return null
      }
      costs.ordered++
      return journal.readInOrder(() => {
        const result = journal.readSince({ epoch: journal.epoch, sequence: 0 })
        if (!result.ok) {
          throw new Error('unreadable real journal')
        }
        costs.storeRows += result.rows.length
        return { ...evidence, epoch: journal.epoch }
      })
    }
    for (const edge of ['initial', 'repeat'] as const) {
      Object.keys(costs).forEach((key) => Reflect.set(costs, key, 0))
      if (edge === 'repeat' && mode === 'busy') {
        delivery.onJournalActivity('session')
      } else {
        delivery.deliverForHandle('consumer')
      }
      await new Promise<void>((done) => setImmediate(done))
      console.log({ count, mode, edge, ...costs })
      expect(costs.inventory).toBeLessThanOrEqual(mode === 'busy' ? 2 : 3)
      expect(costs.raw).toBeGreaterThanOrEqual(count)
      expect(costs.raw).toBeLessThanOrEqual(6 * count)
      expect(costs.receipts).toBeLessThanOrEqual(3 * count)
      expect(costs.ordered).toBe(sources.size)
      expect(costs.storeRows).toBeGreaterThanOrEqual(sources.size)
      expect(costs.candidates).toBeLessThanOrEqual(mode === 'busy' ? 0 : 3 * count + 3)
      expect(costs.rows).toBeLessThanOrEqual(6 * count)
      expect(send).not.toHaveBeenCalled()
      for (const [id, handoff] of saved) {
        expect(db.getMessageById(id)?.handoff).toBe(handoff)
      }
    }
    if (mode !== 'busy') {
      const fresh = db.insertMessage({
        from: 'sender',
        to: 'consumer',
        subject: 'independent report'
      })
      delivery.deliverForHandle('consumer')
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      const notice = send.mock.calls[0]![0].body.from?.orchestration
      expect(notice).toMatchObject({ messages: [{ messageId: fresh.id }] })
      evidence.owner = {
        itemId: 'full-turn',
        turn: { turnId: 'full-turn', state: 'completed', outcome: 'success' }
      }
      evidence.legacyNotice = notice?.message === 'mail-notice' ? notice : null
      delivery.onJournalActivity('session')
      await vi.waitFor(() => expect(db.getMessageById(fresh.id)?.read).toBe(1))
      expect(send).toHaveBeenCalledOnce()
      for (const [id, handoff] of saved) {
        expect(db.getMessageById(id)?.handoff).toBe(handoff)
      }
    }
  }
)

it.each([100, 1000])(
  'drains C=%i concurrent flights with linear own-interest routing',
  async (count) => {
    const { db, host } = harness()
    const routes = new Map(Array.from({ length: count }, (_, i) => [`a${i}`, `s${i}`]))
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>()
    const prepare = vi.spyOn(host, 'readHandoffEvidence').mockImplementation(async () => {
      await barrier
      return host.readHandoffEvidenceNow({ sessionId: '', clientMessageId: '' })
    })
    host.takesMailNow = () => false
    const resolve = vi.fn((address: string) => {
      const sessionId = routes.get(address)
      return sessionId ? { sessionId, dispatchId: null } : null
    })
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      resolveStructuredTarget: resolve,
      getMessageWaiters: () => undefined,
      getCliCommand: () => 'orca',
      senderName: () => null,
      host
    })
    for (const [address, session] of routes) {
      delivery.deliverForHandle(address)
      delivery.deliverForHandle(address)
      delivery.onJournalActivity(session)
    }
    expect(prepare).toHaveBeenCalledTimes(count)
    routes.delete('a0')
    routes.set('a1', 's2')
    routes.set('a2', 'idle')
    release()
    await new Promise<void>((done) => setImmediate(done))
    expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2 * count - 1)
    expect(resolve.mock.calls.length).toBeLessThan(12 * count)
    expect(host.send).not.toHaveBeenCalled()
    const before = resolve.mock.calls.length
    delivery.onJournalActivity('s0')
    expect(resolve).toHaveBeenCalledTimes(before)
  }
)

it.each(['failed', 'disappeared', 'changed'] as const)(
  'rolls back exact settlement before %s source preparation',
  async (failure) => {
    const { db, host, delivery, evidence, message, send } = harness()
    send.mockRejectedValueOnce(new Error('crashed issued operation'))
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    await new Promise<void>((done) => setImmediate(done))
    const issuedReference = readMailHandoff(db.getMessageById(message.id)!.handoff)
    if (issuedReference?.kind !== 'structured') {
      throw new Error('missing committed input')
    }
    host.takesMailNow = () => false
    host.readReceipt = () => queuedReceipt(issuedReference, 'actual')
    delivery.onJournalActivity('session')
    await vi.waitFor(() =>
      expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
        phase: 'offered',
        clientMessageId: 'actual'
      })
    )
    const saved = db.getMessageById(message.id)!.handoff
    const other = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'uncertain source' })
    db.db
      .prepare('UPDATE messages SET handoff = ?, recovery_used = 1 WHERE id = ?')
      .run(JSON.stringify({ ...issuedReference, sessionId: 'source' }), other.id)
    let original = db.getMessageById(other.id)!.handoff
    evidence.mailHold = {
      members: new Set([message.id]),
      ambiguous: true,
      key: 'stopped',
      scope: { aliases: ['session', 'source'], root: 'session' }
    }
    evidence.owner = {
      itemId: 'done',
      turn: { turnId: 'done', state: 'completed', outcome: 'success' }
    }
    const notice = send.mock.calls[0]![0].body.from?.orchestration
    evidence.legacyNotice = notice?.message === 'mail-notice' ? notice : null
    host.readReceipt = (ref) =>
      ref.sessionId === 'source' ? { verdict: 'absent' } : queuedReceipt(ref, 'actual')
    const prepare = vi.spyOn(host, 'readHandoffEvidence').mockImplementation(async (source) => {
      if (source.sessionId !== 'session') {
        expect(db.db.isTransaction).toBe(false)
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          handoff: saved
        })
        if (failure === 'changed' && source.sessionId === 'source') {
          await new Promise<void>((done) => setImmediate(done))
          expect(db.db.isTransaction).toBe(false)
          const later = db.insertMessage({
            from: 'sender',
            to: 'consumer',
            subject: 'new dependency'
          })
          issued(db, [later.id], { sessionId: 'later' })
          db.db.prepare('UPDATE messages SET handoff = ? WHERE id = ?').run(
            JSON.stringify({
              ...issuedReference,
              sessionId: 'source',
              recoverySource: { sessionId: 'original', epoch: 'epoch', clientMessageId: 'original' }
            }),
            other.id
          )
          original = db.getMessageById(other.id)!.handoff
          evidence.mailHold = {
            members: new Set(),
            ambiguous: false,
            key: 'new facts',
            scope: { root: 'session', aliases: ['session', 'source', 'later'] }
          }
          host.takesMailNow = () => true
        } else if (failure === 'changed') {
          evidence.mailHold = {
            members: new Set([other.id]),
            ambiguous: true,
            key: 'personal Stop'
          }
          host.takesMailNow = () => false
        }
        return failure === 'failed' ? null : evidence
      }
      return evidence
    })
    host.readHandoffEvidenceNow = (source) =>
      source.sessionId === 'source' && failure !== 'changed' ? null : evidence
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(failure === 'changed' ? 5 : 2))
    await new Promise<void>((done) => setImmediate(done))
    expect(db.getMessageById(message.id)?.read).toBe(Number(failure !== 'disappeared'))
    expect(db.getMessageById(other.id)).toMatchObject({
      handoff: original,
      recovery_used: 1,
      read: 0
    })
    if (failure === 'changed') {
      expect(prepare.mock.calls.slice(0, 4).map(([source]) => source.sessionId)).toEqual([
        'session',
        'source',
        'later',
        'original'
      ])
    }
    expect(send).toHaveBeenCalledOnce()
  }
)

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

it.each(['accepted', 'absent', 'unreadable'] as const)(
  'reconciles a crashed immutable cohort read-only (%s) before delivering an independent survivor',
  async (receipt) => {
    const { db, message, delivery, send, host, evidence } = harness()
    const survivor = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'old survivor' })
    const cohort = await selectStructuredMailHandoff({
      db,
      mailbox: 'consumer',
      sessionId: 'session',
      epoch: 'epoch',
      frontier: 'frontier',
      waiters: undefined,
      reservedTypes: undefined,
      readEvidence: () => evidence,
      manifest: (messages) => ({
        members: messages.map((m) => m.id),
        dispatchId: null,
        runtimeFence: 1,
        body: JSON.stringify({ kind: 'message', role: 'user', blocks: [] })
      })
    })
    if (!cohort) {
      throw new Error('Missing legacy cohort')
    }
    db.recordMailHandoff('consumer', cohort.messages, {
      ...cohort.reference,
      nonAdmission: undefined
    })
    send.mockRejectedValueOnce(new Error('crash before receipt metadata'))
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const original = readMailHandoff(db.getMessageById(survivor.id)!.handoff)
    if (original?.kind !== 'structured') {
      throw new Error('missing reserved input')
    }
    db.recordUnknownMailRead([message])
    const fresh = db.insertMessage({
      from: 'sender',
      to: 'consumer',
      subject: 'same-count replacement'
    })
    host.readReceipt = (reference) =>
      reference.operationId !== original.operationId
        ? { verdict: 'absent' }
        : receipt === 'accepted'
          ? queuedReceipt(original, 'actual-queue')
          : receipt === 'absent'
            ? { verdict: 'absent' }
            : {
                verdict: 'unreadable',
                scope: { kind: 'global' },
                operationId: original.operationId
              }
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() =>
      expect(readMailHandoff(db.getMessageById(fresh.id)?.handoff)).toMatchObject({
        phase: 'offered'
      })
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(readMailHandoff(db.getMessageById(fresh.id)?.handoff)).toMatchObject({
      manifest: { members: [fresh.id] }
    })
    expect(JSON.stringify(send.mock.calls[1]![0].body.blocks)).toContain(
      '**Subject:** same-count replacement'
    )
    expect(send.mock.calls[1]![0].body.from?.orchestration).toMatchObject({
      messages: [{ messageId: fresh.id }]
    })
    expect(readMailHandoff(db.getMessageById(survivor.id)?.handoff)).toMatchObject({
      phase: receipt === 'accepted' ? 'offered' : 'reserved',
      operationId: original.operationId,
      manifest: original.manifest
    })
    expect(db.getMessageById(survivor.id)?.recovery_used).toBe(0)
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)?.kind).toBe('unknown')
  }
)

it('does not turn expiry of an uncertain original operation into proof it never ran', async () => {
  const { db, message, delivery, send } = harness()
  send.mockRejectedValueOnce(new Error('crash'))
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const original = db.getMessageById(message.id)!.handoff
  send.mockResolvedValue({ kind: 'sent', state: 'rejected', nonAdmission: 'expired' })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(db.getMessageById(message.id)!.handoff).toBe(original)
  expect(send).toHaveBeenCalledTimes(2)
})

it('redrives second-connection arrivals across preparation and commits before effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr28567-admission-revision-'))
  roots.push(root)
  const path = join(root, 'mail.db')
  const { db, message, delivery, host, evidence, send } = harness(path)
  const writer = new OrchestrationDb(path)
  databases.push(writer)
  evidence.mailHold = { members: new Set(), ambiguous: true, key: 'held' }
  const scan = vi.spyOn(db, 'getAutomaticMailCandidates')
  const claim = vi.spyOn(db, 'claimMailHandoff')
  const { promise: barrier, resolve: unblock } = Promise.withResolvers<void>()
  const prepare = vi.spyOn(host, 'readHandoffEvidence').mockImplementationOnce(async () => {
    await barrier
    return evidence
  })
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  writer.insertMessage({ from: 'sender', to: 'consumer', subject: 'during await' })

  evidence.mailHold = { members: new Set(), ambiguous: false, key: 'person-resume' }
  send.mockImplementation(async (input) => {
    expect(db.db.isTransaction).toBe(false)
    expect(claim.mock.results.at(-1)?.value).toMatchObject({ address: 'consumer' })
    const selected = db.getUnreadMessages('consumer')[0]!
    expect(readMailHandoff(selected.handoff)).toMatchObject({
      operationId: input.operationId,
      phase: 'reserved'
    })
    expect(readMailHandoff(selected.handoff)).not.toHaveProperty('nonAdmission')
    expect(input.beforeRun()).toBe(true)
    host.takesMailNow = () => false
    return { kind: 'sent', state: 'accepted' }
  })
  unblock()
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(
    claim.mock.results.filter((result) => result.type === 'return' && result.value !== null)
  ).toHaveLength(1)
  await vi.waitFor(() =>
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
      phase: 'offered',
      operationId: send.mock.calls[0]![0].operationId
    })
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  const settled = scan.mock.calls.length
  delivery.onJournalActivity('session')
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(scan).toHaveBeenCalledTimes(settled)
  expect(send).toHaveBeenCalledOnce()
})
