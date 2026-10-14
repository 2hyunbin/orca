import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEditedText } from '../../../src/shared/queued-message-text-edit'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  batchEvent,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

describe('mobile in-place queued Edit', () => {
  let renderer: ReactTestRenderer | undefined
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | undefined
  let listener: ((data: unknown) => void) | undefined
  const append = vi.fn(() => true)
  const error = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness({
    sessionId = SESSION_ID,
    editSupport = true
  }: {
    sessionId?: string
    editSupport?: boolean | null
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity: 'host-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport:
        editSupport === null
          ? null
          : {
              ...CAPABLE,
              queuedMessages: false,
              queuedMessageEdit: editSupport
            },
      appendComposerText: append,
      onSendError: error
    })
    return null
  }
  async function mount(message: AgentSessionQueuedMessage, editSupport: boolean | null = true) {
    vi.clearAllMocks()
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.queuedMessageEditHold'
        ? ok({ status: 'held', fingerprint: 'fp', leaseDurationMs: 120_000, remainingMs: 120_000 })
        : method === 'agentSession.queuedMessageUpdate'
          ? mutationOk({ status: 'updated', messageId: message.messageId, fingerprint: 'new' })
          : ok({ models: [], current: {} })
    )
    await act(async () => {
      renderer = create(createElement(Harness, { editSupport }))
    })
    act(() => listener?.(snapshotEvent({ queuedMessages: [message], runningTurn: true })))
    if (editSupport !== null) {
      await act(async () => {
        expect(await hook!.queued.edit!(message.messageId)).toBe(true)
      })
    }
  }
  afterEach(async () => {
    await act(async () => renderer?.unmount())
    vi.useRealTimers()
  })

  it('waits for the capability probe before offering the legacy fallback', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }), null)
    expect(hook!.queued.edit).toBeUndefined()
    expect(
      sendRequest.mock.calls.some(
        ([method]) =>
          method === 'agentSession.queuedMessageDelete' ||
          method === 'agentSession.queuedMessageEditHold'
      )
    ).toBe(false)
    await act(async () => renderer?.update(createElement(Harness, { editSupport: false })))
    expect(hook!.queued.edit).toEqual(expect.any(Function))
  })

  it('holds and renews a card while typing, saves its text without replacing images, and cancels in place', async () => {
    const message = queuedDraft({
      messageId: 'image-card',
      position: 7,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'original' },
          { type: 'image-ref', path: '/images/snapshot.png' }
        ]
      }
    })
    vi.useFakeTimers()
    await mount(message)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const holdCalls = () =>
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageEditHold')
    const acquire = fieldsOf(holdCalls()[0]?.[1])
    expect(acquire).toMatchObject({
      sessionId: SESSION_ID,
      messageId: 'image-card',
      action: 'acquire',
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION_ID, message.body)
    })
    expect(fieldsOf(holdCalls()[1]?.[1])).toMatchObject({ action: 'renew', editId: acquire.editId })
    act(() => hook!.queued.editor!.change('edited'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(true)
    })
    const update = sendRequest.mock.calls.find(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(update?.[1])).toMatchObject({
      messageId: 'image-card',
      text: 'edited',
      expectedBodyFingerprint: acquire.expectedBodyFingerprint
    })
    expect(fieldsOf(update?.[1])).not.toHaveProperty('body')
    const body = queuedMessageWithEditedText(message.body, 'edited')!
    act(() => listener?.(batchEvent([{ ...message, body }])))
    expect(hook!.queued.cards).toMatchObject([{ messageId: 'image-card', text: 'edited' }])
    expect(body.blocks).toContainEqual({ type: 'image-ref', path: '/images/snapshot.png' })
    expect(hook!.queued.editor).toBeUndefined()
    expect(fieldsOf(holdCalls().at(-1)?.[1])).toMatchObject({
      action: 'release',
      editId: acquire.editId
    })
    await act(async () => {
      await hook!.queued.edit!('image-card')
    })
    act(() => hook!.queued.editor!.change('cancelled'))
    await act(async () => hook!.queued.editor!.cancel())
    expect(hook!.queued.cards[0]?.text).toBe('edited')
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageDelete')
    ).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('settles a lost Save reply from the published card and keeps a conflicting edit in the composer', async () => {
    const message = queuedDraft({ messageId: 'draft-1' })
    await mount(message)
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({ status: 'changed', messageId: 'draft-1' })
        : ok({ status: 'held' })
    )
    act(() => hook!.queued.editor!.change('my text'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(false)
    })
    expect(append).toHaveBeenCalledWith('my text')
    expect(error).toHaveBeenCalledWith(
      'This message changed while you were editing. Your edit is in the chat box.'
    )
    await act(async () => {
      await hook!.queued.edit!('draft-1')
    })
    act(() => hook!.queued.editor!.change('saved text'))
    const body = queuedMessageWithEditedText(message.body, 'saved text')!
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.queuedMessageUpdate') {
        listener?.(batchEvent([{ ...message, body }]))
        throw markRpcDeliveryUnknown(new Error('reply lost'))
      }
      return ok({ status: 'held' })
    })
    await act(async () => {
      await hook!.queued.editor!.save()
    })
    expect(hook!.queued.editor).toBeUndefined()
    expect(hook!.queued.cards[0]?.text).toBe('saved text')
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('keeps unsaved typing in the originating draft and releases the hold when changing chats', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }))
    act(() => hook!.queued.editor!.change('unsaved'))
    await act(async () => renderer?.update(createElement(Harness, { sessionId: 'other-chat' })))
    expect(append).toHaveBeenCalledWith('unsaved')
    expect(hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['acquire', 'release'])
  })
})
