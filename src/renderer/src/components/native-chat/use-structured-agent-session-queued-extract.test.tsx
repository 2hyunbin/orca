import { createRef } from 'react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionSendBody
} from '../../../../shared/structured-agent-session-send-mutation'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import * as handback from './structured-agent-session-message-hand-back'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

const scope = 'queued-extraction'
const image = { url: 'https://example.com/queued.png', alt: 'diagram' }
const skills = [
  { name: 'review', path: '/one/SKILL.md' },
  { name: 'review', path: '/two/SKILL.md' }
]
const message: AgentSessionQueuedMessage = {
  messageId: 'mail',
  position: 1,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: '$review $review [Image #1]' },
      { type: 'image-ref', ...image }
    ],
    skills,
    from: { kind: 'agent', senders: [], orchestration: null }
  }
}

afterEach(() => {
  cleanup()
  clearNativeChatDraftCacheForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function harness(write: StructuredAgentSessionWrite, prompt = false) {
  const send = vi.fn<NativeChatStructuredComposerTransport['send']>(() => true)
  const transport: NativeChatStructuredComposerTransport = {
    send,
    runtime: 'local',
    sessionId: 'session',
    runtimeEnvironmentId: null,
    onError: vi.fn(),
    optionSnapshot: [],
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: async () => ({ snapshot: [] }),
      invokeAction: async () => ({ snapshot: [] }),
      subscribe: () => () => {}
    }
  }
  const mutate = vi.fn(async () => null)
  const hook = renderHook(() => {
    const queue = useStructuredAgentSessionQueuedMessages({
      enabled: true,
      queuedMessages: [message],
      queuePause: { reason: 'stopped' },
      submissions: [],
      hasPendingPrompt: prompt,
      isWorking: false,
      composerScopeKey: scope,
      mutate,
      editTransport: {
        target: { kind: 'local' },
        sessionId: 'session',
        capable: true,
        copyDeleteCapable: true,
        write
      }
    })
    const draft = readNativeChatComposerDraft(scope)
    const submit = useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: draft.images,
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: (text) => updateNativeChatComposerDraft(scope, { text }, 'immediate'),
      setCaret: vi.fn()
    })
    return { queue, submit }
  })
  return { ...hook, send, mutate }
}

it('durably appends full mail before conditional Delete, then sends as an ordinary user message', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  const old = { name: 'old', path: '/legacy/SKILL.md' }
  updateNativeChatComposerDraft(
    scope,
    {
      text: 'already typing $old',
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'already typing ' },
              { type: 'nativeChatSkill', attrs: { token: '$old', path: old.path } }
            ]
          }
        ]
      }
    },
    'immediate'
  )
  const calls = vi.fn((..._args: unknown[]) => {})
  const write: StructuredAgentSessionWrite = async <T,>(
    ...args: Parameters<StructuredAgentSessionWrite>
  ) => {
    calls(...args)
    const draft = readNativeChatComposerDraft(scope)
    expect(draft.text).toContain('already typing $old\n\n$review')
    expect(draft.images[0]?.reference).toEqual(image)
    expect(draft.document?.content?.flatMap((node) => node.content ?? [])).toContainEqual({
      type: 'nativeChatSkill',
      attrs: { token: '$review', path: skills[0]?.path }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this flow issues only queuedMessageDelete.
    return { kind: 'done', value: { deleted: true, messageId: 'mail' } as T }
  }
  let hook = harness(write)
  await act(() => hook.result.current.queue.edit('mail'))
  expect(hook.result.current.queue.editor).toBeUndefined()
  expect(calls).toHaveBeenCalledExactlyOnceWith(
    'agentSession.queuedMessageDelete',
    'agentSession.queuedMessageDelete',
    {
      messageId: 'mail',
      expectedBodyFingerprint: agentSessionSendBodyFingerprint('session', message.body)
    }
  )
  await nativeChatComposerDraftWritesSettled()
  hook.unmount()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  const draft = readNativeChatComposerDraft(scope)
  const inputRef = createRef<NativeChatComposerInput>()
  const editor = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      scopeKey={scope}
      initialValue={draft.text}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  await waitFor(() =>
    expect(editor.container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(3)
  )
  expect(inputRef.current?.value).toBe(draft.text)
  hook = harness(write)
  await act(() => hook.result.current.submit(inputRef.current?.value ?? ''))
  const [text, attachments, request] = hook.send.mock.calls[0]!
  const sent = structuredAgentSessionSendBody(
    text,
    attachments.map((attachment) => ({ ...attachment, previewUri: '' })),
    request?.skills
  )
  expect(sent).toEqual({
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'already typing $old\n\n$review $review [Image #1]' },
      { type: 'image-ref', ...image }
    ],
    skills: [old, ...skills]
  })
  expect(hook.mutate).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(scope).text).toBe('')
})

it('retains the copied draft after Delete refusal and appends again on a deliberate retry', async () => {
  const write: StructuredAgentSessionWrite = async () => ({
    kind: 'not-done',
    notice: 'This queued message changed.',
    failure: { kind: 'refused', code: 'agent_session_operation_invalid' }
  })
  const hook = harness(write)
  await act(() => hook.result.current.queue.edit('mail'))
  await act(() => hook.result.current.queue.edit('mail'))
  const draft = readNativeChatComposerDraft(scope)
  expect(draft.images).toHaveLength(2)
  expect(draft.images[0]?.id).not.toBe(draft.images[1]?.id)
  expect(draft.text.match(/\$review/gu)).toHaveLength(4)
  expect(toast.error).toHaveBeenCalledTimes(2)
  expect(toast.error).toHaveBeenLastCalledWith(
    'This queued message changed. A copy is in the chat box.'
  )
})

it('keeps the card when draft storage refuses or a question/approval is open', async () => {
  const write: StructuredAgentSessionWrite = vi.fn(async () => ({ kind: 'dropped' }))
  const blocked = harness(write, true)
  await act(() => blocked.result.current.queue.edit('mail'))
  expect(blocked.result.current.queue.editDisabledReason).toContain('before editing')
  expect(readNativeChatComposerDraft(scope).text).toBe('')
  blocked.unmount()
  vi.spyOn(handback, 'returnMessageToComposer').mockReturnValue(false)
  const hook = harness(write)
  await act(() => hook.result.current.queue.edit('mail'))
  expect(write).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
  expect(hook.result.current.queue.cards[0]?.messageId).toBe('mail')
})
