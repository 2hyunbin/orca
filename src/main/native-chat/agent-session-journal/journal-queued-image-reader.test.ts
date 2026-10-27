import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import {
  readQueuePublication,
  type QueuePublication
} from '../agent-session-wire/structured-agent-session-queued-publication'
import type { Subscriber } from '../agent-session-wire/structured-agent-session-subscribers'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const journals = createTrackedJournalOpener()
const identity = {
  sessionId: 'recovery-images',
  workspaceId: 'ws',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
let root: string
let journal: AgentSessionJournal
let lease: ReturnType<typeof agentSessionLeaseFixture>
let clock = 1000
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'b1-image-recovery-'))
  lease = agentSessionLeaseFixture({ sessionId: identity.sessionId })
  journal = await journals.open({ identity, stateDirectory: root, now: () => ++clock })
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
async function send(id: string, handed = true, message = body(id)) {
  await journal.appendSubmission({
    clientMessageId: id,
    body: message,
    payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, message),
    fence: 7,
    origin: 'client',
    source: { kind: 'user' },
    handoverRecorded: true
  })
  if (handed) {
    await journal.resolveDispatch({
      clientMessageId: id,
      state: 'pending',
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
}
async function receipt(id: string) {
  await journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    fence: 7,
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'receipt', ordinal: clock }
  })
}

it('delivers deferred hidden image sources in bounded semantic batches without resetting expanded history', async () => {
  const { AgentSessionSubscribers } =
    await import('../agent-session-wire/structured-agent-session-subscribers')
  const { queuedImageReaderSnapshot, queuedImageReaderEvent, queuedImageSourceIds } =
    await import('../agent-session-wire/agent-session-queued-image-reader')
  const { deferFirstRecoveryPresentation, finishFirstRecoveryPresentation } =
    await import('../agent-session-wire/structured-agent-session-queued-publication')
  const { projectQueuedImageCardPublication } =
    await import('../../runtime/rpc/methods/structured-agent-session-queued-image-capability')
  const { MOBILE_BRIDGE_MAX_FRAME_BYTES } =
    await import('../../../shared/mobile-bridge-frame-bytes')
  const { emitSubscriberFrame } =
    await import('../agent-session-wire/agent-session-subscriber-frame-fields')
  const { emptyAgentSessionBatch } = await import('../agent-session-wire/agent-session-empty-batch')
  const frames: AgentSessionSubscribeEvent[] = []
  const child = { fence: 7, generation: 'replayed-child' }
  for (let i = 0; i < 10; i++) {
    await send(`image-${i}`, true, {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: `${i}:${'x'.repeat(150_000)}` },
        { type: 'image-ref', url: 'https://example.test/original.png' }
      ]
    })
  }
  const idleWork = structuredAgentSessionCurrentWork(journal, {
    record: agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: identity.sessionId,
        runtimeFence: 7,
        claimStatus: 'released'
      })
    )
  })
  journal.queuedMessages.recoveryWork = () => idleWork
  await journal.rollEpoch('unreconcilable_prefix', 7)
  deferFirstRecoveryPresentation(journal, child)
  const subscribers = new AgentSessionSubscribers({
    readQueuePublication: () =>
      readQueuePublication(journal, () => ({
        record: agentSessionRecordFixture(lease),
        work: idleWork
      })),
    readCurrentWork: () => idleWork
  })
  const projected = {
    readHistorySnapshot: queuedImageReaderSnapshot,
    readQueueSourceIds: queuedImageSourceIds,
    projectJournalEvent: queuedImageReaderEvent,
    projectQueuePublication: (pub: QueuePublication) =>
      projectQueuedImageCardPublication(pub, { clientKind: 'mobile' })
  }
  subscribers.open({
    id: 'old',
    sessionId: identity.sessionId,
    journal,
    fence: 7,
    emit: (event) => frames.push(event),
    boundedFrames: true,
    ...projected
  })
  expect(frames[0]?.type === 'snapshot' && frames[0].page.items).toEqual([])
  frames.length = 0
  const deferredPublication = subscribers.readQueuePublication(identity.sessionId)!
  const baseline = journal.cursor()
  let calls = 0
  const retryFrames: typeof frames = []
  const target: Subscriber = {
    id: 'retry',
    sessionId: identity.sessionId,
    fence: 7,
    cursor: baseline,
    boundedFrames: true,
    queuePublication: deferredPublication,
    projectQueuePublication: projected.projectQueuePublication,
    projectJournalEvent: (...args) => queuedImageReaderEvent(journal, ...args),
    emit: (event) => {
      if (++calls === 2) {
        throw new Error('transport lost after first fragment')
      }
      retryFrames.push(event)
    }
  }
  finishFirstRecoveryPresentation(journal, child)
  const correction = {
    type: 'batch' as const,
    sessionId: identity.sessionId,
    fence: 7,
    hostNow: 1234,
    batch: emptyAgentSessionBatch(baseline)
  }
  const hooks = { readQueuePublication: () => subscribers.readQueuePublication(identity.sessionId) }
  expect(() => emitSubscriberFrame(hooks, target, correction, { currentWork: idleWork })).toThrow(
    'transport lost'
  )
  expect(target.queuePublication).toBe(deferredPublication)
  expect(target.cursor).toEqual(baseline)
  retryFrames.length = 0
  target.emit = (event) => retryFrames.push(event)
  emitSubscriberFrame(hooks, target, correction, { currentWork: idleWork })
  expect(target.queuePublication).toBe(subscribers.readQueuePublication(identity.sessionId))
  expect(
    new Set(
      retryFrames.flatMap((event) =>
        event.type === 'batch' ? event.batch.items.map((item) => item.itemId) : []
      )
    ).size
  ).toBe(10)
  for (const event of retryFrames) {
    if (event.type === 'batch') {
      expect(event.batch.cursor).toEqual(baseline)
      expect(event.fence).toBe(7)
      expect(event.hostNow).toBe(1234)
    }
  }
  subscribers.publish(identity.sessionId, journal)
  expect(frames.every((event) => event.type === 'batch')).toBe(true)
  const inserted = frames.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
  expect(new Set(inserted.map((item) => item.itemId)).size).toBe(10)
  for (const event of frames) {
    expect(
      Buffer.byteLength(
        JSON.stringify({ v: 1, type: 'event', id: 'stream', seq: 100, payload: event })
      )
    ).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
    if (event.type === 'batch' && event.batch.items.length > 0) {
      expect(event.working).toBe(false)
      expect(event.latestTurn).toEqual(idleWork.publishedLatestTurn(null))
      expect(event.fence).toBe(7)
      expect(event.batch.cursor).toEqual(baseline)
    }
  }
  frames.length = 0
  subscribers.publish(identity.sessionId, journal, { turnId: 't', text: 'metadata only' })
  expect(frames.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))).toEqual([])
  await journal.queuedMessages.withdraw(['recovery:image-0'])
  subscribers.publish(identity.sessionId, journal)
  expect(
    frames.flatMap((event) => (event.type === 'batch' ? event.batch.removedItemIds : []))
  ).toContain(agentJournalSubmissionKey('image-0'))
  expect(frames.every((event) => event.type === 'batch')).toBe(true)
  const original = journal.submissionBody('image-1')!
  await journal.appendSubmission(
    {
      clientMessageId: 'new-V',
      body: original,
      payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, original),
      fence: 7,
      handoverRecorded: true,
      origin: 'client'
    },
    { messageId: 'recovery:image-1', expect: 'returned' }
  )
  await journal.resolveDispatch({
    clientMessageId: 'new-V',
    state: 'pending',
    fence: 7,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  subscribers.publish(identity.sessionId, journal)
  expect(journal.queuedMessages.get('recovery:image-1')).toMatchObject({
    state: 'dispatched',
    consumedAs: 'new-V'
  })
  expect(journal.queuedMessages.get('recovery:new-V')?.body).toEqual(original)
  await journal.acceptLate({
    clientMessageId: 'image-1',
    state: 'accepted',
    fence: 7,
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'late-U', ordinal: 0 }
  })
  subscribers.publish(identity.sessionId, journal)
  expect(journal.submission('image-1')?.dispatchState).toBe('accepted')
  expect(journal.submission('new-V')?.dispatchState).toBe('pending')
  expect(journal.queuedMessages.get('recovery:new-V')?.body).toEqual(original)
  expect(
    queuedImageReaderSnapshot(journal).items.some(
      (item) => item.itemId === agentJournalSubmissionKey('image-1')
    )
  ).toBe(false)
  expect(frames.every((event) => event.type === 'batch')).toBe(true)
  await journals.closeAll()
  journal = await journals.open({ identity, stateDirectory: root, now: () => ++clock })
  const reopenedWork = structuredAgentSessionCurrentWork(journal, {
    record: agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: identity.sessionId,
        runtimeFence: 7,
        claimStatus: 'released'
      })
    )
  })
  journal.queuedMessages.recoveryWork = () => reopenedWork
  expect(journal.submission('image-1')?.dispatchState).toBe('accepted')
  expect(journal.queuedMessages.get('recovery:new-V')?.body).toEqual(original)
  expect(
    queuedImageReaderSnapshot(journal).items.some(
      (item) => item.itemId === agentJournalSubmissionKey('image-1')
    )
  ).toBe(false)
})

it.each([100, 1000].flatMap((n) => ['none', 'visible', 'cut'].map((source) => ({ n, source }))))(
  'avoids added history population work for $source source and $n visible rows on ten real publishes',
  async ({ n, source }) => {
    const { AgentSessionSubscribers } =
      await import('../agent-session-wire/structured-agent-session-subscribers')
    const { queuedImageReaderSnapshot, queuedImageReaderEvent, queuedImageSourceIds } =
      await import('../agent-session-wire/agent-session-queued-image-reader')
    const idleWork = structuredAgentSessionCurrentWork(journal, {
      record: agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: identity.sessionId,
          runtimeFence: 7,
          claimStatus: 'released'
        })
      )
    })
    journal.queuedMessages.recoveryWork = () => idleWork
    if (source !== 'none') {
      await send('active-image', true, {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'active' },
          { type: 'image-ref', url: 'https://example.test/a.png' }
        ]
      })
      if (source === 'cut') {
        await journal.rollEpoch('unreconcilable_prefix', 7)
        expect(journal.item(agentJournalSubmissionKey('active-image'))).toBeNull()
      }
    }
    async function append(recordId: string) {
      await journal.appendItem(
        { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId },
        { kind: 'status', text: recordId },
        { fence: 7 }
      )
    }
    for (let i = 0; i < n; i++) {
      await append(`seed-${i}`)
    }
    const frames: AgentSessionSubscribeEvent[] = []
    const capable: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () =>
        readQueuePublication(journal, () => ({
          record: agentSessionRecordFixture(lease),
          work: idleWork
        })),
      readCurrentWork: () => idleWork
    })
    subscribers.open({
      id: 'perf-old',
      sessionId: identity.sessionId,
      journal,
      fence: 7,
      emit: (event) => frames.push(event),
      boundedFrames: true,
      readHistorySnapshot: queuedImageReaderSnapshot,
      readQueueSourceIds: queuedImageSourceIds,
      projectJournalEvent: queuedImageReaderEvent
    })
    subscribers.open({
      id: 'perf-current',
      sessionId: identity.sessionId,
      journal,
      fence: 7,
      emit: (event) => capable.push(event),
      boundedFrames: true
    })
    const sourceKey = agentJournalSubmissionKey('active-image')
    const cold = queuedImageReaderSnapshot(journal)
    expect(cold.items.some((item) => item.itemId === sourceKey)).toBe(source !== 'none')
    const baseline = journal.cursor()
    frames.length = 0
    capable.length = 0
    const operations = { adapter: 0, inherited: 0 }
    const original = journal.snapshot.bind(journal)
    function watched<T>(values: T[]): T[] {
      return new Proxy(values, {
        get(target, key, receiver) {
          const adapter =
            new Error('population read').stack?.includes('queuedImageReaderSnapshot') === true
          const bucket = adapter ? 'adapter' : 'inherited'
          if (key === Symbol.iterator) {
            return function* () {
              for (const value of target) {
                operations[bucket]++
                yield value
              }
            }
          }
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            operations[bucket]++
          }
          // Array methods use the proxy receiver, counting every numeric read, including map/slice/splice.
          return Reflect.get(target, key, receiver)
        }
      })
    }
    const spy = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
      const snapshot = original()
      return {
        ...snapshot,
        items: watched(snapshot.items),
        submissions: watched(snapshot.submissions)
      }
    })
    try {
      for (let i = 0; i < 10; i++) {
        await append(`output-${i}`)
        subscribers.publish(identity.sessionId, journal)
      }
    } finally {
      spy.mockRestore()
    }
    console.info('compatibility operation counts', { n, source, ...operations })
    expect(operations.adapter).toBe(0)
    for (const delivered of [frames, capable]) {
      expect(delivered.every((event) => event.type === 'batch')).toBe(true)
      const items = delivered.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
      expect(
        items.filter((item) => item.body.kind === 'status' && item.body.text.startsWith('output-'))
      ).toHaveLength(10)
      expect(items.some((item) => item.itemId === sourceKey)).toBe(false)
      expect(delivered.at(-1)?.type === 'batch' && delivered.at(-1)).toMatchObject({
        batch: { cursor: journal.cursor() }
      })
    }
    expect(journal.cursor().sequence - baseline.sequence).toBe(10)
    if (source !== 'none') {
      expect(journal.queuedMessages.list().filter((row) => row.state === 'returned')).toHaveLength(
        1
      )
      await receipt('active-image')
    }
  }
)

it('projects a still-active cut source before stateless and middle-page catch-up decisions, with cold reset fallback', async () => {
  const { queuedImageHistoryReader, queuedImageSubscriber } =
    await import('../../runtime/rpc/methods/structured-agent-session-queued-image-capability')
  const { readAgentSessionHistory, createAgentSessionCatchUpReader } =
    await import('../agent-session-wire/agent-session-history-page')
  const { AgentSessionSubscribers } =
    await import('../agent-session-wire/structured-agent-session-subscribers')
  const idleWork = structuredAgentSessionCurrentWork(journal, {
    record: agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: identity.sessionId,
        runtimeFence: 7,
        claimStatus: 'released'
      })
    )
  })
  journal.queuedMessages.recoveryWork = () => idleWork
  await send('cut-touch', true, {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'original immutable' },
      { type: 'image-ref', url: 'https://example.test/original.png' }
    ]
  })
  await journal.rollEpoch('unreconcilable_prefix', 7)
  const cursor = journal.cursor()
  const key = agentJournalSubmissionKey('cut-touch')
  expect(journal.item(key)).toBeNull()
  await journal.markPendingSubmissionsUnknown(7)
  for (let i = 0; i < 3; i++) {
    await journal.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: 'thread', recordId: `later-${i}` },
      { kind: 'status', text: `later-${i}` },
      { fence: 7 }
    )
  }
  const reader = queuedImageHistoryReader({ clientKind: 'mobile' })!
  const request = { sessionId: identity.sessionId, direction: 'after' as const, cursor, limit: 1 }
  const first = readAgentSessionHistory(journal, request, { reader })
  expect(first).toMatchObject({
    ok: true,
    page: {
      hasNewer: true,
      removedItemIds: [],
      items: [expect.objectContaining({ itemId: key })],
      submissions: [expect.objectContaining({ clientMessageId: 'cut-touch' })]
    }
  })
  expect(first.page.submissions[0]).not.toHaveProperty('queuedMessageId')
  const read = createAgentSessionCatchUpReader(journal, reader)
  const middle = read(request)
  expect(middle).toEqual(first)
  const next = read({ ...request, cursor: middle.page.window.nextCursor })
  expect(next.ok).toBe(true)
  expect(next.page.removedItemIds).not.toContain(key)
  expect(next.page.window.nextCursor.sequence).toBeGreaterThan(
    middle.page.window.nextCursor.sequence
  )
  for (const resetCursor of [
    undefined,
    { ...cursor, epoch: 'stale' },
    { ...cursor, sequence: journal.cursor().sequence + 1 }
  ]) {
    const reset = readAgentSessionHistory(journal, { ...request, cursor: resetCursor }, { reader })
    expect(reset.ok).toBe(false)
    expect(reset.page.items).toContainEqual(expect.objectContaining({ itemId: key }))
  }
  const staleBackward = readAgentSessionHistory(
    journal,
    {
      ...request,
      direction: 'before',
      cursor: { ...cursor, epoch: 'stale' }
    },
    { reader }
  )
  expect(staleBackward.ok).toBe(false)
  expect(staleBackward.page.items.filter((item) => item.itemId === key)).toHaveLength(1)
  const frames: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    readQueuePublication: () =>
      readQueuePublication(journal, () => ({
        record: agentSessionRecordFixture(lease),
        work: idleWork
      })),
    readCurrentWork: () => idleWork
  })
  subscribers.open({
    id: 'reconnect',
    sessionId: identity.sessionId,
    journal,
    fence: 7,
    cursor,
    boundedFrames: true,
    snapshotCatchUp: false,
    emit: (event) => frames.push(event),
    ...queuedImageSubscriber({ clientKind: 'mobile' })
  })
  expect(frames.every((event) => event.type === 'batch')).toBe(true)
  expect(
    frames.flatMap((event) => (event.type === 'batch' ? event.batch.removedItemIds : []))
  ).not.toContain(key)
  expect(
    frames.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
  ).toContainEqual(expect.objectContaining({ itemId: key }))
  expect(journal.item(key)).toBeNull()
})
