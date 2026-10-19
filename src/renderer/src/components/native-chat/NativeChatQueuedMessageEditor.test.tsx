// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import {
  useStructuredAgentSessionQueuedEdit,
  type QueuedMessageInlineEditor
} from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from './structured-agent-session-queued-cards'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import type * as NativeChatAttachmentUpload from './native-chat-attachment-upload'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async (
    _target: unknown,
    _method: string,
    params: { action: string }
  ) =>
    params.action === 'release'
      ? { status: 'released' }
      : {
          status: 'held',
          fingerprint: 'f'.repeat(64),
          leaseDurationMs: 120_000,
          remainingMs: 120_000
        }
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/components/editor/useLocalImageSrc', () => ({ useLocalImageSrc: () => undefined }))
vi.mock('./native-chat-attachment-upload', async (original) => ({
  ...(await original<typeof NativeChatAttachmentUpload>()),
  resolveNativeChatAttachmentOwnerForWorktree: () => ({ kind: 'local' })
}))
vi.mock('./native-chat-clipboard-image-save', () => ({
  ownerAcceptsClipboardImage: () => true,
  saveNativeChatPastedClipboardImage: async () => ({ status: 'saved', tempPath: '/tmp/new.png' })
}))
afterEach(cleanup)
function editor(): QueuedMessageInlineEditor {
  return {
    messageId: 'mail',
    text: 'full message',
    acquiring: false,
    saving: false,
    canSave: true,
    change: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn()
  }
}
function view(
  edit: QueuedMessageInlineEditor,
  prompt: 'question' | 'approval' | null,
  answer = vi.fn(),
  promptCancel = vi.fn()
) {
  return (
    <div data-native-chat-root="true">
      <ul>
        <li>
          <NativeChatQueuedMessageEditor editor={edit} />
        </li>
      </ul>
      {prompt === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: 'Allow command?',
            options: [{ label: 'Allow', send: 'allow' }]
          }}
          onChoose={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
      {prompt === 'question' ? (
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'Which?',
                options: [{ label: 'One' }],
                multiSelect: false
              }
            ]
          }}
          onAnswer={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
    </div>
  )
}
describe('queued card textarea', () => {
  it.each(['question', 'approval'] as const)(
    'stays mounted and focused when a %s opens, its keys apart from the prompt',
    (prompt) => {
      const edit = editor()
      const answer = vi.fn()
      const promptCancel = vi.fn()
      const { rerender } = render(view(edit, null, answer, promptCancel))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      rerender(view(edit, prompt, answer, promptCancel))
      expect(document.activeElement).toBe(field)
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(edit.save).toHaveBeenCalledOnce()
      expect(answer).not.toHaveBeenCalled()
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(edit.cancel).toHaveBeenCalledOnce()
      expect(promptCancel).not.toHaveBeenCalled()
    }
  )
  it.each(['question', 'approval'] as const)(
    'focuses and saves with a %s already open',
    (prompt) => {
      const edit = editor()
      render(view(edit, prompt))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(edit.save).toHaveBeenCalledOnce()
    }
  )
  it('Enter and the platform modifier save, Shift+Enter is a newline and handled keys do not bubble', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(edit.save).toHaveBeenCalledOnce()
    expect(parent).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(edit.save).toHaveBeenCalledOnce()
    for (const [platform, modifier] of [
      ['Macintosh', { metaKey: true }],
      ['Linux', { ctrlKey: true }],
      ['Windows', { ctrlKey: true }]
    ] as const) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      fireEvent.keyDown(field, { key: 'Enter', ...modifier })
    }
    expect(edit.save).toHaveBeenCalledTimes(4)
    vi.restoreAllMocks()
  })
  it('IME confirmation and Escape never commit/cancel or reach the prompt', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(edit.save).not.toHaveBeenCalled()
    expect(edit.cancel).not.toHaveBeenCalled()
    expect(parent).not.toHaveBeenCalled()
  })
  it('acquisition seeds a read-only field with the X always usable', () => {
    const edit = { ...editor(), acquiring: true }
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByRole('textbox').getAttribute('readonly')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
  })
  it('the header X cancels and saves nothing; Save is the only footer action', () => {
    const edit = editor()
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByText('Editing message')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
    expect(edit.save).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual(['Cancel editing', 'Save'])
  })
  it.each([
    { state: 'saving', edit: { saving: true } },
    { state: 'unchanged', edit: { canSave: false } }
  ])('Save is disabled while $state and enabled otherwise', ({ edit: overrides }) => {
    const edit = { ...editor(), ...overrides }
    const { rerender } = render(<NativeChatQueuedMessageEditor editor={edit} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(edit.save).not.toHaveBeenCalled()
    rerender(<NativeChatQueuedMessageEditor editor={{ ...edit, saving: false, canSave: true }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(edit.save).toHaveBeenCalledOnce()
  })
  it('Save carries a decorative Enter badge and no key hint text', () => {
    for (const platform of ['Macintosh', 'Windows']) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      const { container, unmount } = render(<NativeChatQueuedMessageEditor editor={editor()} />)
      const save = screen.getByRole('button', { name: 'Save' })
      const badge = save.querySelector('[aria-hidden="true"]')
      expect(badge?.querySelector('svg')).toBeTruthy()
      expect(badge?.textContent).toBe('')
      expect(container.textContent).not.toMatch(/Shift|⇧|new line/)
      unmount()
    }
    vi.restoreAllMocks()
  })
})

const card: AgentSessionQueuedMessage = {
  messageId: 'card',
  position: 1,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'see [Image #1] and [Image #2]' },
      { type: 'image-ref', path: '/host/old.png' },
      { type: 'image-ref', path: '/host/kept.png' }
    ]
  }
}
const writeSpy = vi.fn(async (..._args: unknown[]) => ({
  kind: 'done',
  value: { status: 'updated', messageId: 'card', fingerprint: 'a'.repeat(64) }
}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers only queuedMessageUpdate, with that method's result.
const write = writeSpy as StructuredAgentSessionWrite

function EditedCard({ imagesCapable }: { imagesCapable: boolean }): React.JSX.Element | null {
  const messages = [card]
  const { editor, begin } = useStructuredAgentSessionQueuedEdit({
    transport: { target: { kind: 'local' }, sessionId: 's', capable: true, imagesCapable, write },
    messages,
    cards: projectQueuedMessageCards(messages, [], {}),
    submissions: [],
    composerScopeKey: 'draft',
    promptOpen: false
  })
  useEffect(() => void begin('card'), [begin])
  const attachTo = {
    terminalTabId: 'tab',
    transport: { sessionId: 's', worktreeId: 'wt', runtimeEnvironmentId: null, acceptsImages: true }
  }
  return editor ? (
    <TooltipProvider>
      <ul>
        <li>
          <NativeChatQueuedMessageEditor editor={editor} attachTo={attachTo} images="1 image" />
        </li>
      </ul>
    </TooltipProvider>
  ) : null
}

function savedParams(): unknown {
  return writeSpy.mock.calls.at(-1)?.[2]
}

describe('queued card image edit', () => {
  it('removes a kept image with its marker, pastes a new one and saves the new set', async () => {
    writeSpy.mockClear()
    render(<EditedCard imagesCapable />)
    const field = await screen.findByRole('textbox', { name: 'Edit message' })
    await waitFor(() => expect(field.getAttribute('readonly')).toBeNull())
    expect(screen.queryByText('1 image')).toBeNull()
    expect(screen.getByText('Paste or drop images')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove attachment' })[0]!)
    // The field shows what the agent will read: the removed image's marker goes, #2 becomes #1.
    expect(field).toHaveProperty('value', 'see and [Image #1]')
    const data = new DataTransfer()
    data.items.add(new File(['png'], 'new.png', { type: 'image/png' }))
    act(() => {
      field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /View image/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
    expect(savedParams()).toMatchObject({
      text: 'see and [Image #1]',
      images: [
        { type: 'image-ref', path: '/host/kept.png' },
        { type: 'image-ref', path: '/tmp/new.png' }
      ]
    })
  })

  it('against a host that edits text only, shows the count and saves text alone', async () => {
    writeSpy.mockClear()
    render(<EditedCard imagesCapable={false} />)
    const field = await screen.findByRole('textbox', { name: 'Edit message' })
    await waitFor(() => expect(field.getAttribute('readonly')).toBeNull())
    expect(screen.getByText('1 image')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull()
    fireEvent.change(field, { target: { value: 'see that' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
    expect(savedParams()).toEqual({
      messageId: 'card',
      expectedBodyFingerprint: expect.any(String),
      text: 'see that'
    })
  })
})
