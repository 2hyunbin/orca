import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEditedText } from '../../../src/shared/queued-message-text-edit'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
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
  const resolved = vi.fn()
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
    editSupport = true,
    enabled = true
  }: {
    sessionId?: string
    editSupport?: boolean | null
    enabled?: boolean
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity: 'host-a',
      enabled,
      connected: enabled,
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
      onSendError: error,
      onActionResolved: resolved
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

  it('keeps stale and unconfirmed edits in the editor without copying them', async () => {
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
    expect(hook!.queued.editor?.text).toBe('my text')
    expect(error).toHaveBeenCalledWith('This message changed while you were editing.')
    expect(append).not.toHaveBeenCalled()
    act(() => hook!.queued.editor!.cancel())
    await act(async () => hook!.queued.edit!('draft-1'))
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
    expect(hook!.queued.editor?.text).toBe('saved text')
    expect(hook!.queued.cards[0]?.text).toBe('saved text')
    expect(error).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
  })

  it('abandons unsaved typing and releases the hold when changing chats', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }))
    act(() => hook!.queued.editor!.change('unsaved'))
    await act(async () => renderer?.update(createElement(Harness, { sessionId: 'other-chat' })))
    expect(append).not.toHaveBeenCalled()
    expect(hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['acquire', 'release'])
  })

  it.each(['updated', 'changed'] as const)(
    'ignores a deferred %s reply after leaving the chat',
    async (status) => {
      const message = queuedDraft({ messageId: 'deferred-card' })
      await mount(message)
      let answer: ((response: RpcResponse) => void) | undefined
      sendRequest.mockImplementation((method) =>
        method === 'agentSession.queuedMessageUpdate'
          ? new Promise<RpcResponse>((resolve) => {
              answer = resolve
            })
          : Promise.resolve(ok({ status: 'held' }))
      )
      act(() => hook!.queued.editor!.change('edited in place'))
      let save: Promise<boolean> | undefined
      act(() => {
        save = hook!.queued.editor!.save()
      })
      expect(hook!.queued.editor!.saving).toBe(true)
      await act(async () => renderer?.update(createElement(Harness, { sessionId: 'other-chat' })))
      expect(append).not.toHaveBeenCalled()
      await act(async () => {
        answer?.(mutationOk({ status, messageId: message.messageId, fingerprint: 'new' }))
        await save
      })
      expect(append).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(resolved).not.toHaveBeenCalled()
      expect(hook!.queued.editor).toBeUndefined()
    }
  )

  it('suppresses a late refusal notice after unmount', async () => {
    const message = queuedDraft({ messageId: 'lost-reply-card' })
    await mount(message)
    let answer: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method) =>
      method === 'agentSession.queuedMessageUpdate'
        ? new Promise<RpcResponse>((resolve) => {
            answer = resolve
          })
        : Promise.resolve(ok({ status: 'held' }))
    )
    act(() => hook!.queued.editor!.change('landed despite disconnect'))
    let save: Promise<boolean> | undefined
    act(() => {
      save = hook!.queued.editor!.save()
    })
    await act(async () => renderer?.unmount())
    await act(async () => {
      answer?.(
        ok({
          ok: false,
          refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
        })
      )
      await save
    })
    expect(append).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps a refused Save in the editor and closes only when the published card is gone', async () => {
    const message = queuedDraft({ messageId: 'refused-card' })
    await mount(message)
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.queuedMessageUpdate'
        ? ok({
            ok: false,
            refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
          })
        : ok({ status: 'held' })
    )
    act(() => hook!.queued.editor!.change('keep this text'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(false)
    })
    expect(hook!.queued.editor?.text).toBe('keep this text')
    expect(hook!.queued.editor?.saving).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    act(() => listener?.(batchEvent([])))
    expect(hook!.queued.editor).toBeUndefined()
  })

  it('preserves typing when a late hold answer reports a conflict', async () => {
    const message = queuedDraft({ messageId: 'slow-hold-card' })
    await mount(message)
    act(() => hook!.queued.editor!.cancel())
    let answerHold: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageEditHold' && fieldsOf(params).action === 'acquire'
        ? new Promise<RpcResponse>((resolve) => {
            answerHold = resolve
          })
        : method === 'agentSession.queuedMessageEditHold'
          ? Promise.resolve(ok({ status: 'held' }))
          : Promise.resolve(
              mutationOk({ status: 'updated', messageId: message.messageId, fingerprint: 'new' })
            )
    )
    await act(async () => hook!.queued.edit!(message.messageId))
    act(() => hook!.queued.editor!.change('new typing'))
    expect(hook!.queued.editor!.text).toBe('new typing')
    await act(async () => {
      answerHold?.(ok({ status: 'changed' }))
    })
    expect(hook!.queued.editor?.text).toBe('new typing')
    expect(error).toHaveBeenCalledWith('This message changed while you were editing.')
    expect(append).not.toHaveBeenCalled()
  })

  it('submits Save while hold acquisition is still pending', async () => {
    const message = queuedDraft({ messageId: 'save-before-hold' })
    await mount(message)
    act(() => hook!.queued.editor!.cancel())
    let answerHold: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageEditHold' && fieldsOf(params).action === 'acquire'
        ? new Promise<RpcResponse>((resolve) => {
            answerHold = resolve
          })
        : method === 'agentSession.queuedMessageEditHold'
          ? Promise.resolve(ok({ status: 'held' }))
          : Promise.resolve(
              mutationOk({ status: 'updated', messageId: message.messageId, fingerprint: 'new' })
            )
    )
    await act(async () => hook!.queued.edit!(message.messageId))
    act(() => hook!.queued.editor!.change('saved without hold reply'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(true)
    })
    expect(hook!.queued.editor).toBeUndefined()
    expect(answerHold).toBeDefined()
    await act(async () => answerHold?.(ok({ status: 'held' })))
    expect(append).not.toHaveBeenCalled()
  })
})
