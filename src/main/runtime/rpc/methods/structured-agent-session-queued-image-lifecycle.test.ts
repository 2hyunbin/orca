import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { mobileQueuedMessageCards } from '../../../../../mobile/src/session/mobile-structured-queued-message-cards'
import { buildMobileNativeChatTransientData } from '../../../../../mobile/src/session/mobile-native-chat-render-data'
import { isRenderableImageUri } from '../../../../../mobile/src/session/mobile-native-chat-image-preview'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  call,
  openStream,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import {
  queuedImageHistoryReader,
  projectQueuedImageCardHistory
} from './structured-agent-session-queued-image-capability'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryRequest } from '../../../../shared/agent-session-wire'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'

const OLD = { ...STRUCTURED_MOBILE_CLIENT, clientId: 'old-phone', connectionId: 'old-phone' }
const MODERN = {
  clientId: 'modern',
  connectionId: 'modern',
  clientKind: 'runtime' as const,
  clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
}
let rig: QueuedMessageTestRig | undefined
const current = () => {
  if (!rig) {
    throw new Error('missing rig')
  }
  return rig
}
const journal = () => {
  const value = current().host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!value) {
    throw new Error('missing journal')
  }
  return value
}
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
})
async function history(
  request: Omit<AgentSessionHistoryRequest, 'sessionId'> = { direction: 'tail' },
  old = true
) {
  const result = await current().host.history(
    { sessionId: SESSION, ...request },
    undefined,
    old ? queuedImageHistoryReader(OLD) : undefined
  )
  return old ? projectQueuedImageCardHistory(result, OLD) : result
}
async function imageBody(text = 'original'): Promise<AgentJournalMessageItem> {
  const dir = join(
    agentSessionAttachmentStoreRoot(current().root),
    '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a'
  )
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture image bytes')
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      { type: 'image-ref', path }
    ]
  }
}
async function sendImage(body: AgentJournalMessageItem) {
  const id = hostTestOperationId()
  const fields = { body, options: { model: 'default' } }
  expect(
    await call(
      'agentSession.send',
      { envelope: current().envelope(fields, 'agentSession.send', id), ...fields },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  return id
}
async function failedImage() {
  await current().host.close(SESSION, 'evict')
  current().failNextStart(new Error('fixture start failed'))
  const body = await imageBody()
  const id = await sendImage(body)
  await eventually(async () => expect(await current().drafts()).toHaveLength(1))
  return {
    id,
    body,
    card: journal()
      .queuedMessages.list()
      .find((row) => row.state === 'returned')!
  }
}

it('installs old-reader source and exact controls through RPC, disk reopen, Send and Delete without changing capable readers', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const { id, body, card } = await failedImage()
  expect(card.body).toEqual(body)
  expect(isRenderableImageUri(body.blocks.find((block) => block.type === 'image-ref')?.path)).toBe(
    false
  )
  const old = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, OLD)
  expect(old).toMatchObject({
    result: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
        ]),
        queuedMessages: [
          expect.objectContaining({
            messageId: card.messageId,
            body: expect.objectContaining({ command: { name: 'compact' } })
          })
        ]
      }
    }
  })
  expect(
    await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, MODERN)
  ).toMatchObject({ result: { page: { queuedMessages: [expect.objectContaining({ body })] } } })
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  const reopened = await history()
  expect(reopened.page.items).toContainEqual(
    expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
  )
  expect(reopened.page.submissions.find((send) => send.clientMessageId === id)).not.toHaveProperty(
    'keptAsQueuedMessageId'
  )
  const frames = await openStream('agentSession.subscribe', { sessionId: SESSION }, OLD)
  const modernFrames = await openStream('agentSession.subscribe', { sessionId: SESSION }, MODERN)
  const sendFields = { messageId: card.messageId }
  const sendParams = {
    envelope: rig.envelope(sendFields, 'agentSession.queuedMessageSend', hostTestOperationId()),
    ...sendFields
  }
  expect(await call('agentSession.queuedMessageSend', sendParams, OLD)).toMatchObject({
    result: { ok: true }
  })
  await eventually(() => expect(rig!.dispatch).toHaveBeenCalled())
  const dispatches = rig.dispatch.mock.calls.length
  expect(await call('agentSession.queuedMessageSend', sendParams, OLD)).toMatchObject({
    result: { ok: true }
  })
  expect(rig.dispatch.mock.calls.length).toBe(dispatches)
  expect(rig.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ body })
  expect((await rig.handoff(card.messageId))?.options).toEqual({ model: 'default' })
  expect((await history()).page.queuedMessages).toEqual([])
  expect(
    frames.some(
      (frame) =>
        'result' in frame &&
        frame.result &&
        JSON.stringify(frame.result).includes('"queuedMessages":[]')
    )
  ).toBe(true)
  expect(
    modernFrames.some(
      (frame) =>
        'result' in frame &&
        frame.result &&
        JSON.stringify(frame.result).includes('"queuedMessages":[]')
    )
  ).toBe(true)
  expect(
    frames.filter(
      (frame) =>
        'result' in frame && frame.result && JSON.stringify(frame.result).includes('"type":"reset"')
    )
  ).toEqual([])
  await rig.stop()
  await rig.settleAccepted((await rig.handoff(card.messageId))!.clientMessageId, 'echo')
  await rig.host.close(SESSION, 'evict')
  rig.failNextStart(new Error('again'))
  const deleted = await sendImage(body)
  await eventually(async () => expect((await rig!.drafts()).length).toBeGreaterThan(0))
  const exact = journal()
    .queuedMessages.list()
    .find((row) => row.messageId === deleted || row.recovers === deleted)!
  const fields = { messageId: exact.messageId }
  expect(
    await call(
      'agentSession.queuedMessageDelete',
      {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageDelete', hostTestOperationId()),
        ...fields
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  const deletedPage = (await history()).page
  expect(
    projectStructuredAgentSessionMessages(deletedPage.items, [], deletedPage.submissions).some(
      (item) => item.id === agentJournalSubmissionKey(deleted)
    )
  ).toBe(false)
  await rig.quitRestartHostProcess()
  const reopenedDeleted = (await history()).page
  expect(
    projectStructuredAgentSessionMessages(
      reopenedDeleted.items,
      [],
      reopenedDeleted.submissions
    ).some((item) => item.id === agentJournalSubmissionKey(deleted))
  ).toBe(false)
})

it('keeps a hidden original pageable beyond1024 rows and retires its overlay after changed Save and exact late proof', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const { id, body, card } = await failedImage()
  const j = journal()
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await j.rollEpoch('unreconcilable_prefix', fence)
  expect(
    j.snapshot().items.find((item) => item.itemId === agentJournalSubmissionKey(id))
  ).toBeUndefined()
  for (let i = 0; i < 1030; i++) {
    await j.appendItem(
      { provider: 'legacy', agent: 'codex', sessionId: 'history', recordId: `row-${i}` },
      { kind: 'status', text: `${i}` },
      { fence }
    )
  }
  const tail = await history()
  expect(tail.page.hasOlder).toBe(true)
  expect(
    tail.page.items.find((item) => item.itemId === agentJournalSubmissionKey(id))
  ).toBeUndefined()
  let before = tail.page.window.nextCursor
  let older = await history({ direction: 'before', cursor: before, limit: 200 })
  while (
    older.page.hasOlder &&
    !older.page.items.some((item) => item.itemId === agentJournalSubmissionKey(id))
  ) {
    before = older.page.window.nextCursor
    older = await history({ direction: 'before', cursor: before, limit: 200 })
  }
  expect(older.page.items).toContainEqual(
    expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
  )
  expect((await history({ direction: 'after', cursor: { epoch: 'stale', sequence: 0 } })).ok).toBe(
    false
  )
  const rpc = await call(
    'agentSession.history',
    { sessionId: SESSION, direction: 'before', cursor: before, limit: 200 },
    OLD
  )
  expect(rpc).toMatchObject({
    result: {
      page: {
        queuedMessages: [
          expect.objectContaining({
            messageId: card.messageId,
            body: expect.objectContaining({ command: { name: 'compact' } })
          })
        ]
      }
    }
  })
  const fields = {
    messageId: card.messageId,
    expectedBodyFingerprint: card.fingerprint,
    text: 'original'
  }
  expect(
    await call(
      'agentSession.queuedMessageUpdate',
      {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...fields
      },
      MODERN
    )
  ).toMatchObject({ result: { ok: true, value: { status: 'unchanged' } } })
  expect(
    (await history({ direction: 'before', cursor: before, limit: 200 })).page.items
  ).toContainEqual(expect.objectContaining({ itemId: agentJournalSubmissionKey(id) }))
  const changed = { ...fields, text: 'changed' }
  expect(
    await call(
      'agentSession.queuedMessageUpdate',
      {
        envelope: rig.envelope(changed, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...changed
      },
      MODERN
    )
  ).toMatchObject({ result: { ok: true, value: { status: 'updated' } } })
  const selected = await history({
    direction: 'before',
    cursor: before,
    limit: 200
  })
  expect(
    selected.page.items.find((item) => item.itemId === agentJournalSubmissionKey(id))
  ).toBeUndefined()
  expect(j.queuedMessages.get(card.messageId)).toMatchObject({
    body: { blocks: [{ type: 'text', text: 'changed' }, body.blocks[1]] },
    options: { model: 'default' }
  })
  const pub = rig.host.collaboratorsForTests().subscribers.readQueuePublication(SESSION)!
  const { projectQueuedImageCardPublication } =
    await import('./structured-agent-session-queued-image-capability')
  const oldCards = projectQueuedImageCardPublication(pub, OLD)
  const model = mobileQueuedMessageCards(oldCards.queuedMessages, selected.page.submissions, {
    agentWorking: true
  })
  expect(model).toMatchObject([{ messageId: card.messageId, command: true, waitsForAgent: true }])
  expect(
    mobileQueuedMessageCards(oldCards.queuedMessages, selected.page.submissions, {
      agentWorking: false
    })[0]
  ).not.toHaveProperty('waitsForAgent')
  await rig.settleAccepted(id, 'late-original')
  expect(j.queuedMessages.get(card.messageId)?.body.blocks[0]).toEqual({
    type: 'text',
    text: 'changed'
  })
  expect(
    j.snapshot().items.find((item) => item.itemId === agentJournalSubmissionKey(id))
  ).toBeUndefined()
  await rig.quitRestartHostProcess()
  await history()
  expect(journal().queuedMessages.get(card.messageId)?.body.blocks[0]).toEqual({
    type: 'text',
    text: 'changed'
  })
  expect(
    journal()
      .snapshot()
      .items.find((item) => item.itemId === agentJournalSubmissionKey(id))
  ).toBeUndefined()
})

it('hides an ordinary original after changed Save while retaining its exact live control and independent edited handoff', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const { id, body, card } = await failedImage()
  const before = await history()
  expect(
    projectStructuredAgentSessionMessages(before.page.items, [], before.page.submissions)
  ).toContainEqual(expect.objectContaining({ id: agentJournalSubmissionKey(id) }))
  const messages = projectStructuredAgentSessionMessages(
    before.page.items,
    [],
    before.page.submissions
  )
  const transient = buildMobileNativeChatTransientData({
    messages,
    folded: messages,
    streaming: null,
    pending: [],
    imagePreviewsByMessageId: {
      [agentJournalSubmissionKey(id)]: ['file:///device/composer-preview.png']
    }
  })
  expect(JSON.stringify(transient.data)).toContain('file:///device/composer-preview.png')
  const frames = await openStream('agentSession.subscribe', { sessionId: SESSION }, OLD)
  const fields = {
    messageId: card.messageId,
    expectedBodyFingerprint: card.fingerprint,
    text: 'edited original'
  }
  expect(
    await call(
      'agentSession.queuedMessageUpdate',
      {
        envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
        ...fields
      },
      MODERN
    )
  ).toMatchObject({ result: { ok: true, value: { status: 'updated' } } })
  const changed = await history()
  expect(
    projectStructuredAgentSessionMessages(changed.page.items, [], changed.page.submissions).some(
      (item) => item.id === agentJournalSubmissionKey(id)
    )
  ).toBe(false)
  expect(
    mobileQueuedMessageCards(changed.page.queuedMessages ?? [], changed.page.submissions)
  ).toMatchObject([
    { messageId: card.messageId, command: true, text: expect.stringContaining('edited original') }
  ])
  expect(frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        result: expect.objectContaining({
          type: 'batch',
          batch: expect.objectContaining({
            submissions: expect.arrayContaining([
              expect.objectContaining({
                clientMessageId: id,
                keptAsQueuedMessageId: card.messageId
              })
            ])
          })
        })
      }),
      expect.objectContaining({
        result: expect.objectContaining({
          queuedMessages: expect.arrayContaining([
            expect.objectContaining({
              messageId: card.messageId,
              body: expect.objectContaining({ command: { name: 'compact' } })
            })
          ])
        })
      })
    ])
  )
  expect(isRenderableImageUri('file:///device/composer-preview.png')).toBe(true)
  expect(isRenderableImageUri('data:image/png;base64,AA==')).toBe(true)
  expect(isRenderableImageUri(body.blocks.find((block) => block.type === 'image-ref')?.path)).toBe(
    false
  )
  const send = { messageId: card.messageId }
  expect(
    await call(
      'agentSession.queuedMessageSend',
      {
        envelope: rig.envelope(send, 'agentSession.queuedMessageSend', hostTestOperationId()),
        ...send
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(async () => expect(await rig!.handoff(card.messageId)).toBeDefined())
  const handed = (await rig.handoff(card.messageId))!
  expect(handed.clientMessageId).not.toBe(id)
  const handedBody = journal().submissionBody(handed.clientMessageId)
  expect(handedBody).toEqual({
    ...body,
    blocks: [{ type: 'text', text: 'edited original' }, body.blocks[1]]
  })
  expect(handed.options).toEqual({ model: 'default' })
  await rig.settleAccepted(id, 'old-u-after-edited-v')
  expect((await rig.handoff(card.messageId))?.dispatchState).toBe(handed.dispatchState)
  expect((await history()).page.queuedMessages).toEqual([])
  await rig.quitRestartHostProcess()
  const reopened = (await history()).page
  expect(reopened.queuedMessages).toMatchObject([{ messageId: card.messageId, state: 'waiting' }])
  expect(reopened.queuedMessages).toHaveLength(1)
  expect(journal().submission(id)?.dispatchState).toBe('rejected')
  expect(journal().submissionBody(handed.clientMessageId)).toEqual(handedBody)
  expect(journal().queuedMessages.get(card.messageId)?.body).toEqual(handedBody)
})

it('keeps an image-only waiting queue and pause visible through Resume and a failed queued start', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  setStructuredAgentSessionHost(rig.host)
  const working = await sendImage(await imageBody('prior work'))
  await eventually(() => expect(rig!.dispatch).toHaveBeenCalled())
  const full = await imageBody()
  const body = { ...full, blocks: full.blocks.filter((block) => block.type === 'image-ref') }
  const id = hostTestOperationId()
  const fields = { body, options: { model: 'default' }, delivery: 'queue-if-active' }
  expect(
    await call(
      'agentSession.send',
      {
        envelope: rig.envelope(fields, 'agentSession.send', id),
        ...fields
      },
      MODERN
    )
  ).toMatchObject({ result: { ok: true, value: { queued: { messageId: id } } } })
  await rig.stop()
  await rig.settleAccepted(working, 'waiting-image-prior-turn')
  const paused = (await history()).page
  expect(paused.queuePause).toMatchObject({ reason: 'stopped' })
  expect(paused.queuedMessages).toMatchObject([{ messageId: id, state: 'waiting' }])
  expect(
    mobileQueuedMessageCards(paused.queuedMessages ?? [], paused.submissions, {
      agentWorking: false
    })
  ).toMatchObject([{ messageId: id, command: true }])
  await rig.quitRestartHostProcess()
  setStructuredAgentSessionHost(rig.host)
  rig.failNextStart(new Error('queued resume start failed'))
  expect(
    await call(
      'agentSession.queuedMessagesResume',
      {
        envelope: rig.envelope({}, 'agentSession.queuedMessagesResume', hostTestOperationId())
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: id, state: 'returned' }])
  )
  const failed = (await history()).page
  expect(failed.queuePause).toBeNull()
  expect(failed.queuedMessages).toMatchObject([{ messageId: id, state: 'returned' }])
  expect(journal().queuedMessages.get(id)).toMatchObject({ body, options: { model: 'default' } })
  const handoff = (await rig.handoff(id))!
  expect(
    projectStructuredAgentSessionMessages(failed.items, [], failed.submissions)
  ).toContainEqual(
    expect.objectContaining({ id: agentJournalSubmissionKey(handoff.clientMessageId) })
  )
  const exact = { messageId: id }
  expect(
    await call(
      'agentSession.queuedMessageDelete',
      {
        envelope: rig.envelope(exact, 'agentSession.queuedMessageDelete', hostTestOperationId()),
        ...exact
      },
      OLD
    )
  ).toMatchObject({ result: { ok: true } })
  expect((await history()).page.queuedMessages).toEqual([])
  expect(journal().submissionBody(handoff.clientMessageId)).toEqual(body)
})
