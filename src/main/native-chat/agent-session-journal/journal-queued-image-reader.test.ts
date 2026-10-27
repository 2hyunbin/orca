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
})

it.each([100, 1000])(
  'adds no unrelated adapter scan on streamed publish over %i retained sends, with and without an active image source',
  async (n) => {
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
    for (let i = 0; i < n; i++) {
      await send(`history-${i}`)
      await receipt(`history-${i}`)
    }
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () =>
        readQueuePublication(journal, () => ({
          record: agentSessionRecordFixture(lease),
          work: idleWork
        })),
      readCurrentWork: () => idleWork
    })
    subscribers.open({
      id: 'perf',
      sessionId: identity.sessionId,
      journal,
      fence: 7,
      emit: () => {},
      boundedFrames: true,
      readHistorySnapshot: queuedImageReaderSnapshot,
      readQueueSourceIds: queuedImageSourceIds,
      projectJournalEvent: queuedImageReaderEvent
    })
    for (const active of [false, true]) {
      if (active) {
        await send('active-image', true, {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'active' },
            { type: 'image-ref', url: 'https://example.test/a.png' }
          ]
        })
        subscribers.publish(identity.sessionId, journal)
      }
      let adapterVisits = 0
      const original = journal.snapshot.bind(journal)
      function watched<T>(values: T[]): T[] {
        return new Proxy(values, {
          get(target, key, receiver) {
            if (key !== 'map') {
              return Reflect.get(target, key, receiver)
            }
            const adapter =
              new Error('adapter operation count').stack?.includes('queuedImageReaderSnapshot') ===
              true
            return (fn: (value: T, index: number, rows: T[]) => unknown) =>
              target.map((value, index) => {
                if (adapter) {
                  adapterVisits++
                }
                return fn(value, index, target)
              })
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
      for (let i = 0; i < 10; i++) {
        await journal.appendItem(
          {
            provider: 'legacy',
            agent: 'codex',
            sessionId: 'thread',
            recordId: `output-${active}-${i}`
          },
          { kind: 'status', text: 'token' },
          { fence: 7 }
        )
        subscribers.publish(identity.sessionId, journal)
      }
      spy.mockRestore()
      expect(adapterVisits).toBe(0)
    }
    await receipt('active-image')
    expect(journal.queuedMessages.list().filter((row) => row.state === 'returned')).toEqual([])
  }
)
