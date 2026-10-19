// @vitest-environment happy-dom
// A long paste becomes a pill where it went at once; the saved file, inline text or the replaced
// selection later takes that pill's place in its own draft, whatever happened to the draft meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { writeNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import {
  nativeChatComposerSendBlock,
  nativeChatPastedTextAdmission
} from './native-chat-composer-pasted-text-references'
import { fileReferenceContent, promptTextContent } from './native-chat-prompt-document'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import { formatNativeChatFileReference as ref } from '../../../../shared/agent-image-paste'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'

const mocks = vi.hoisted(() => ({ save: vi.fn(), prepare: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareNativeChatSessionAttachmentUpload: mocks.prepare
}))

const K = 1024
const LONG = 'x'.repeat(32 * K)
const [A, B] = ['agent-session:a', 'agent-session:b']
const NOT_SAVED = 'This paste was not saved. Paste it again or remove it.'
let owner: NativeChatAttachmentOwner = { kind: 'local' }
let saves: { resolve: (path: string) => void; reject: (error: Error) => void }[] = []
const setNotice = vi.fn()
const seen: {
  paste?: (text: string) => boolean
  api?: ReturnType<typeof useNativeChatComposerAttachments>
} = {}

function Composer({ scopeKey }: { scopeKey: string }) {
  const inputRef = useRef<NativeChatComposerInput>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: true,
    imageReferences: true,
    caret: 0,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => null,
    textareaRef: inputRef,
    setCaret: () => {},
    setDraft: () => {},
    setNotice: () => {}
  })
  seen.api = api
  seen.paste = useNativeChatPastedTextFile({
    scopeKey,
    scopeEditor: api.scopeEditor,
    resolveAttachmentOwner: () => owner,
    insertTypedText: (text) => insertNativeChatPastedText(inputRef.current, text),
    setNotice
  })
  return (
    <NativeChatPromptEditor
      key={scopeKey}
      scopeKey={scopeKey}
      imageRow={api.imageAttachments.map(({ id }) => id)}
      inputRef={inputRef}
      initialValue={readNativeChatComposerDraft(scopeKey).text}
      disabled={false}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}

function open(scopeKey: string, text = '', image = '') {
  const images = image ? [{ id: 'i1', path: image }] : []
  updateNativeChatComposerDraft(scopeKey, { text, images }, 'immediate')
  const view = render(<Composer scopeKey={scopeKey} />)
  const editor = () => promptEditor(view.getByRole('textbox'))
  return {
    view,
    editor,
    value: () => promptValue(view.getByRole('textbox')),
    select: (from: number, to: number) =>
      act(() => void editor().commands.setTextSelection({ from: from + 1, to: to + 1 })),
    paste: (pasted: string) => act(() => void seen.paste?.(pasted)),
    pills: () =>
      [...view.container.querySelectorAll('[data-native-chat-file-reference]')].map((pill) => [
        pill.textContent,
        pill.getAttribute('title')
      ]),
    show: (next: string) => view.rerender(<Composer scopeKey={next} />)
  }
}

const settle = (index: number, path: string) => act(async () => saves[index]?.resolve(path))
beforeEach(() => {
  owner = { kind: 'local' }
  saves = []
  vi.clearAllMocks()
  mocks.save.mockImplementation(
    () => new Promise((resolve, reject) => saves.push({ resolve, reject }))
  )
  vi.stubGlobal('api', { ui: { savePastedTextAsFile: mocks.save } })
})

afterEach(() => {
  cleanup()
  clearNativeChatAttachmentCacheForTests()
})

describe('a long paste into a structured chat', () => {
  it('lands where it went, in its own draft, through later edits, scope switches and undo', async () => {
    const composer = open(A, 'hello world end')
    composer.select(6, 11)
    composer.paste(LONG)
    expect(composer.value()).toMatch(/^hello \[Pasted text\]\(orca-paste:[0-9a-f-]{36}\) end$/)
    await waitFor(() => expect(composer.pills()).toEqual([['Pasted text', null]]))
    act(() => void composer.editor().chain().focus('end').insertContent(' more').run())
    composer.paste(LONG)
    await settle(1, '/p/b.txt')
    await settle(0, '/p/a.txt')
    expect(composer.value()).toBe(`hello ${ref('/p/a.txt')} end more${ref('/p/b.txt')}`)
    // Undo takes back each paste with what it replaced; redo brings back the saved file.
    act(() => {
      composer.editor().commands.undo()
      composer.editor().commands.undo()
      composer.editor().commands.undo()
    })
    expect(composer.value()).toBe('hello world end')
    act(() => void composer.editor().commands.redo())
    expect(composer.value()).toBe(`hello ${ref('/p/a.txt')} end`)

    composer.select(0, 5)
    composer.paste(LONG)
    composer.show(B)
    // Stored as text only: the pill is rebuilt from its token.
    writeNativeChatDraftCache(A, `${readNativeChatComposerDraft(A).text} typed`)
    await settle(2, '/p/c.txt')
    expect(readNativeChatComposerDraft(A).text).toBe(
      `${ref('/p/c.txt')} ${ref('/p/a.txt')} end typed`
    )
    expect(readNativeChatComposerDraft(B).text).toBe('')

    composer.paste(LONG)
    act(() => void composer.editor().commands.setContent(promptTextContent('gone')))
    await settle(3, '/p/d.txt')
    expect(composer.value()).toBe('gone')
    expect(setNotice).not.toHaveBeenCalled()
  })

  it('puts the replaced selection back, picked pills included, when the file is not saved', async () => {
    const composer = open(A, 'see  now')
    const editor = composer.editor()
    act(() => void editor.chain().insertContentAt(5, fileReferenceContent('/w/a.ts')).run())
    act(() => void editor.commands.setTextSelection({ from: 3, to: 7 }))
    composer.paste(LONG)
    expect(composer.value()).not.toContain('/w/a.ts')
    await act(async () => saves[0]?.reject(new Error('disk full')))
    expect(composer.value()).toBe(`see ${ref('/w/a.ts')} now`)
    expect(composer.pills()).toEqual([['a.ts', '/w/a.ts']])
    expect(setNotice).toHaveBeenLastCalledWith("Couldn't attach Pasted text. disk full.", undefined)

    composer.paste(LONG)
    owner = { kind: 'remote' }
    await settle(1, '/p/late.txt')
    expect(composer.value()).toBe(`see ${ref('/w/a.ts')} now`)
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining('changed hosts'), undefined)
  })

  it.each([
    { name: 'a short paste', draft: 'hi ', paste: 'short', file: false },
    { name: 'one at the size line', paste: LONG, file: true },
    { name: 'wide characters over it', paste: 'é'.repeat(16 * K + 1), file: true },
    { name: 'escaped quotes', draft: 'a'.repeat(200 * K), paste: '"'.repeat(30 * K), file: true },
    { name: 'over a selection', draft: 'a'.repeat(250 * K), paste: 'b'.repeat(10 * K), all: true },
    { name: 'by an image', image: 'p'.repeat(240 * K), paste: 'c'.repeat(20 * K), file: true }
  ])('$name', ({ draft = '', paste, all, image = '', file = false }) => {
    const composer = open(A, draft, image)
    act(() => void composer.editor().commands.focus(all ? 'all' : 'end'))
    const images = image ? [{ path: image, previewUri: '' }] : []
    const body = structuredAgentSessionSendBody(all ? paste : draft + paste, images)
    const long = new TextEncoder().encode(paste).length >= LONG.length
    // A file only when the paste is long or the body Send builds would be over.
    expect(long || structuredAgentSessionBlocksTooLarge(body.blocks)).toBe(file)
    composer.paste(paste)
    expect(mocks.save).toHaveBeenCalledTimes(file ? 1 : 0)
    expect(composer.value().includes(paste)).toBe(!file)
  })

  it('goes in inline where the server keeps no files, only while the message still fits', async () => {
    owner = { kind: 'runtime-session', environmentId: 'e1', pairingRevision: 7, sessionId: 's1' }
    let answer = (): void => {}
    mocks.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: false, unsupported: true, notice: 'Update the server.' })
        })
    )
    const fits = 'q'.repeat(40 * K)
    const composer = open(A, 'keep ')
    act(() => void composer.editor().commands.focus('end'))
    composer.paste(fits)
    await act(async () => answer())
    expect(composer.value()).toBe(`keep ${fits}`)
    expect(setNotice).not.toHaveBeenCalled()

    composer.paste('r'.repeat(40 * K))
    act(() => void composer.editor().commands.insertContentAt(1, 'z'.repeat(220 * K)))
    await act(async () => answer())
    expect(composer.value()).toBe(`${'z'.repeat(220 * K)}keep ${fits}`)
    expect(setNotice).toHaveBeenLastCalledWith(expect.stringContaining('256 KB limit'), undefined)
  })

  it('holds Send while it saves without taking an image number, and refuses one a restart lost', async () => {
    const composer = open(A)
    composer.paste(LONG)
    act(() => void seen.api?.beginPendingImageAttachment())
    expect(seen.api?.imageAttachments).toHaveLength(1)
    // Button, Enter and a picked command all read this: Send waits, quietly.
    expect(nativeChatComposerSendBlock([], A).holdsSend).toBe(true)
    expect(nativeChatPastedTextAdmission(A)).toBe('saving')
    await settle(0, '/p/orca-paste-1-u.txt')
    expect(nativeChatPastedTextAdmission(A)).toBeNull()

    // A reload: the pill came back with no saving behind it.
    composer.view.unmount()
    const reloaded = open(B, 'x [Pasted text](orca-paste:00000000-0000-4000-8000-000000000000)')
    await waitFor(() => expect(reloaded.pills()).toEqual([['Paste not saved', NOT_SAVED]]))
    // Send stays open, and refuses with the pill's words rather than send the token.
    expect(nativeChatComposerSendBlock([], B).holdsSend).toBe(false)
    expect(nativeChatPastedTextAdmission(B)).toBe('unsaved')
    act(() => void reloaded.editor().commands.setContent(promptTextContent('x')))
    expect(nativeChatPastedTextAdmission(B)).toBeNull()

    reloaded.show(A)
    await waitFor(() =>
      expect(reloaded.pills()).toEqual([['Pasted text', '/p/orca-paste-1-u.txt']])
    )
  })
})
