import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { readMailHandoff } from './mail-handoff'
import { selectStructuredMailHandoff, type StructuredMailEvidence } from './mailbox-settlement'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'

const roots: string[] = []
const databases: OrchestrationDb[] = []
afterEach(() => {
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
    stopInForce: false,
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
      readEvidence: async () => evidence,
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
          ? {
              verdict: 'readable',
              receipt: {
                operationId: original.operationId,
                sessionId: 'session',
                callerKey: 'caller',
                method: 'agentSession.send',
                fingerprint: 'original',
                acceptedAt: 1,
                status: 'accepted',
                result: { kind: 'queued-draft', messageId: 'actual-queue' }
              }
            }
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
  const receipt = vi.fn(() => ({
    verdict: 'readable' as const,
    receipt: {
      operationId: reference.operationId,
      sessionId: 'session',
      callerKey: 'caller',
      method: 'agentSession.send',
      fingerprint: 'issued',
      acceptedAt: 1,
      status: 'accepted' as const,
      result: { kind: 'queued-draft' as const, messageId: 'issued-queue' }
    }
  }))
  host.readReceipt = receipt
  delivery.onJournalActivity('session')
  await vi.waitFor(() =>
    expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toMatchObject({
      phase: 'offered',
      clientMessageId: 'issued-queue'
    })
  )
  expect(receipt).toHaveBeenCalled()
  evidence.mailHold = { members: new Set([message.id]), ambiguous: true, key: 'stopped' }
  evidence.stopInForce = true
  evidence.owner = {
    itemId: 'issued-turn',
    turn: { turnId: 'issued-turn', state: 'completed', outcome: 'success' }
  }
  evidence.legacyNotice = {
    message: 'mail-notice',
    mailbox: 'consumer',
    dispatchId: null,
    messages: [{ messageId: message.id, runId: message.run_id, from: message.from_handle }],
    carriesMailContent: true
  }
  delivery.onJournalActivity('session')
  await vi.waitFor(() => expect(db.getMessageById(message.id)?.read).toBe(1))
  expect(send).toHaveBeenCalledTimes(1)
})

it.each([10, 100])(
  'does not rescan a %i-row stopped/heartbeat tail on unchanged real journal triggers, but releases on changed permission',
  async (count) => {
    const { db, delivery, send, host, evidence } = harness()
    for (let n = 0; n < count; n++) {
      db.insertMessage({
        from: 'sender',
        to: 'consumer',
        subject: String(n),
        type: n % 2 ? 'status' : 'heartbeat'
      })
    }
    evidence.mailHold = { members: new Set(), ambiguous: true, key: 'unknown' }
    host.takesMailNow = () => false
    const scan = vi.spyOn(db, 'getAutomaticMailCandidates')
    delivery.deliverForHandle('consumer')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const first = scan.mock.calls.length
    expect(first).toBeGreaterThan(0)
    for (let n = 0; n < 10; n++) {
      delivery.onJournalActivity('session')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(scan).toHaveBeenCalledTimes(first)
    expect(send).not.toHaveBeenCalled()
    evidence.mailHold = { members: new Set(), ambiguous: false, key: 'person-resume' }
    host.takesMailNow = () => true
    send.mockImplementation(async () => {
      host.takesMailNow = () => false
      return { kind: 'sent', state: 'accepted' }
    })
    delivery.onJournalActivity('session')
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  }
)

it('redrives a same-connection arrival across an awaited evidence read instead of swallowing its revision into a parked key', async () => {
  const { db, delivery, send, host, evidence } = harness()
  evidence.mailHold = { members: new Set(), ambiguous: true, key: 'held' }
  let unblock: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const original = host.readHandoffEvidence
  let first = true
  host.readHandoffEvidence = async (reference) => {
    const value = await original(reference)
    if (first) {
      first = false
      await blocked
    }
    return value
  }
  const scan = vi.spyOn(db, 'getAutomaticMailCandidates')
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
  const fresh = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'during await' })
  evidence.mailHold = { members: new Set(), ambiguous: false, key: 'person-resume' }
  host.takesMailNow = () => true
  send.mockImplementation(async (input) => {
    expect(input.beforeRun()).toBe(true)
    db.markAsRead([db.getUnreadMessages('consumer')[0]!.id])
    return { kind: 'sent', state: 'accepted' }
  })
  unblock!()
  await vi.waitFor(() => expect(db.getMessageById(fresh.id)?.read).toBe(1))
  expect(send).toHaveBeenCalledTimes(2)
})

it('detects an external connection commit during an awaited scan without rebasing it as its own write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr28567-admission-revision-'))
  roots.push(root)
  const path = join(root, 'mail.db')
  const { db, delivery, host, evidence, send } = harness(path)
  const external = new OrchestrationDb(path)
  databases.push(external)
  evidence.mailHold = { members: new Set(), ambiguous: true, key: 'held' }
  const scan = vi.spyOn(db, 'getAutomaticMailCandidates')
  let unblock: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve
  })
  let first = true
  host.readHandoffEvidence = async () => {
    if (first) {
      first = false
      await barrier
    }
    return evidence
  }
  delivery.deliverForHandle('consumer')
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
  external.insertMessage({
    from: 'external',
    to: 'consumer',
    subject: 'concurrent committed arrival'
  })
  unblock!()
  await vi.waitFor(() => expect(scan.mock.calls.length).toBeGreaterThan(1))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settled = scan.mock.calls.length
  delivery.onJournalActivity('session')
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(scan).toHaveBeenCalledTimes(settled)
  expect(send).not.toHaveBeenCalled()
})
