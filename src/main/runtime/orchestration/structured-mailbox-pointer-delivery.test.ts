import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
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
  const id = mintAgentSessionOperationId(Date.now())
  const reference = readMailHandoff(
    JSON.stringify({
      version: 1,
      kind: 'structured',
      sessionId: 'session',
      epoch: 'epoch',
      frontier: 'frontier',
      operationId: id,
      authorizationId: id,
      clientMessageId: id,
      phase: 'reserved',
      authority: 'consumer',
      manifest: {
        members: ids,
        dispatchId: null,
        runtimeFence: 1,
        body: JSON.stringify({ kind: 'message', role: 'user', blocks: [] })
      },
      ...patch
    })
  )
  if (reference?.kind !== 'structured') {
    throw new Error('invalid issued fixture')
  }
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
      const reference = issued(
        db,
        victim ? [row.id, victim.id] : [row.id],
        mode === 'cohort'
          ? {}
          : {
              sessionId: prior,
              phase: 'offered',
              ...(mode === 'idle'
                ? {
                    recoverySource: {
                      sessionId: original,
                      epoch: 'epoch',
                      clientMessageId: original
                    }
                  }
                : {})
            }
      )
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
    const sql = db.db.prepare.bind(db.db)
    vi.spyOn(db.db, 'prepare').mockImplementation((query) => {
      const statement = sql(query)
      if (
        query.includes('INDEXED BY idx_messages_issued_') ||
        query.includes('INDEXED BY idx_messages_id')
      ) {
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          const rows = all(...args)
          if (query.includes('INDEXED BY idx_messages_id')) {
            costs.members += rows.length
            expect(
              sql(`EXPLAIN QUERY PLAN ${query}`)
                .all(...args)
                .map((row) => row.detail)
                .join(' ')
            ).toContain('SEARCH messages USING INDEX idx_messages_id')
          } else {
            costs.raw += rows.length
          }
          return rows
        })
      }
      return statement
    })
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
    let release = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
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
    const saved = db.getMessageById(message.id)!.handoff
    const reference = readMailHandoff(saved)
    if (reference?.kind !== 'structured') {
      throw new Error('missing committed input')
    }
    const other = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'uncertain source' })
    db.db
      .prepare('UPDATE messages SET handoff = ?, recovery_used = 1 WHERE id = ?')
      .run(JSON.stringify({ ...reference, sessionId: 'source' }), other.id)
    let original = db.getMessageById(other.id)!.handoff
    evidence.mailHold = {
      members: new Set(),
      ambiguous: false,
      key: 'released',
      scope: { aliases: ['session', 'source'], root: 'session' }
    }
    evidence.owner = {
      itemId: 'done',
      turn: { turnId: 'done', state: 'completed', outcome: 'success' }
    }
    const notice = send.mock.calls[0]![0].body.from?.orchestration
    evidence.legacyNotice = notice?.message === 'mail-notice' ? notice : null
    host.takesMailNow = () => false
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
              ...reference,
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

it('reconciles an issued receipt and success while new admission is busy and stopped', async () => {
  const { db, message, delivery, send, host, evidence } = harness()
  send.mockRejectedValueOnce(new Error('crash before receipt metadata'))
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const reference = readMailHandoff(db.getMessageById(message.id)?.handoff)
  if (reference?.kind !== 'structured') {
    throw new Error('Missing issued reservation')
  }
  host.takesMailNow = () => false
  const receipt = vi.fn(() => queuedReceipt(reference, 'issued-queue'))
  host.readReceipt = receipt
  delivery.onJournalActivity('session')
  await vi.waitFor(() =>
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
      phase: 'offered',
      clientMessageId: 'issued-queue'
    })
  )
  evidence.mailHold = { members: new Set([message.id]), ambiguous: true, key: 'stopped' }
  evidence.owner = {
    itemId: 'issued-turn',
    turn: { turnId: 'issued-turn', state: 'completed', outcome: 'success' }
  }
  const notice = send.mock.calls[0]![0].body.from?.orchestration
  evidence.legacyNotice = notice?.message === 'mail-notice' ? notice : null
  delivery.onJournalActivity('session')
  await vi.waitFor(() => expect(db.getMessageById(message.id)?.read).toBe(1))
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['external-held', 'external-released'] as const)(
  'redrives arrivals across awaited preparation and parks stable decisions (%s)',
  async (connection) => {
    const root = mkdtempSync(join(tmpdir(), 'pr28567-admission-revision-'))
    roots.push(root)
    const path = join(root, 'mail.db')
    const { db, message, delivery, host, evidence, send } = harness(path)
    const writer = new OrchestrationDb(path)
    databases.push(writer)
    evidence.mailHold = { members: new Set(), ambiguous: true, key: 'held' }
    const scan = vi.spyOn(db, 'getAutomaticMailCandidates')
    const claim = vi.spyOn(db, 'claimMailHandoff')
    let unblock = () => {}
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve
    })
    let first = true
    host.readHandoffEvidence = async () => {
      const value = evidence
      if (first) {
        first = false
        await barrier
      }
      return value
    }
    delivery.deliverForHandle('consumer')
    await vi.waitFor(() => expect(first).toBe(false))
    writer.insertMessage({ from: 'sender', to: 'consumer', subject: 'during await' })
    const released = connection !== 'external-held'
    if (released) {
      evidence.mailHold = { members: new Set(), ambiguous: false, key: 'person-resume' }
      host.takesMailNow = () => true
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
    }
    unblock()
    if (released) {
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
    } else {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled())
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settled = scan.mock.calls.length
    delivery.onJournalActivity('session')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(scan).toHaveBeenCalledTimes(settled)
    expect(send).toHaveBeenCalledTimes(Number(released))
  }
)
