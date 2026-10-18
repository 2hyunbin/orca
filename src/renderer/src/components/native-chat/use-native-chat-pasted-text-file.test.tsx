// @vitest-environment happy-dom
// A long paste into a structured chat attaches as a file the agent reads, on this machine or in a
// paired server's store, so the message's size bound never meets a pasted log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'

const mocks = vi.hoisted(() => ({
  savePastedTextAsFile: vi.fn(),
  prepareNativeChatSessionAttachmentUpload: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./native-chat-attachment-upload', () => ({
  nativeChatAttachFailedNotice: (names: string[], cause: string) =>
    `Couldn't attach ${names.join(', ')}. ${cause}`,
  nativeChatAttachmentOwnerChangedNotice: () => 'owner changed',
  prepareNativeChatSessionAttachmentUpload: mocks.prepareNativeChatSessionAttachmentUpload
}))

vi.stubGlobal('window', { api: { ui: { savePastedTextAsFile: mocks.savePastedTextAsFile } } })

import {
  NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD,
  useNativeChatPastedTextFile
} from './use-native-chat-pasted-text-file'

const LONG = 'x'.repeat(NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD)
const sessionOwner: NativeChatAttachmentOwner = {
  kind: 'runtime-session',
  environmentId: 'env-1',
  pairingRevision: 7,
  sessionId: 'session-1'
}

let root: Root | null = null

async function renderPaste(options: {
  owner: NativeChatAttachmentOwner
  structured?: boolean
  draft?: string
}) {
  const insertTypedText = vi.fn((_text: string) => true)
  const setNotice = vi.fn()
  const chips = {
    begin: vi.fn(() => 'chip-1'),
    resolve: vi.fn(() => true),
    drop: vi.fn(() => true),
    attachReferences: vi.fn(() => true)
  } satisfies NativeChatPendingAttachmentChips
  let paste: ((text: string) => boolean) | null = null
  function Harness(): null {
    paste = useNativeChatPastedTextFile({
      chips: options.structured === false ? null : chips,
      draft: options.draft ?? '',
      resolveAttachmentOwner: () => options.owner,
      insertTypedText,
      setNotice
    })
    return null
  }
  root = createRoot(document.createElement('div'))
  await act(async () => root?.render(createElement(Harness)))
  return {
    paste: (text: string) => paste?.(text),
    chips,
    insertTypedText,
    setNotice
  }
}

describe('a long paste into a structured chat', () => {
  beforeEach(() => {
    mocks.savePastedTextAsFile.mockReset()
    mocks.prepareNativeChatSessionAttachmentUpload.mockReset()
  })
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('attaches as a file in the paste folder here, behind a pending chip, never as text', async () => {
    mocks.savePastedTextAsFile.mockResolvedValue('/data/native-chat-pastes/orca-paste-1.txt')
    const view = await renderPaste({ owner: { kind: 'local' } })
    await act(async () => {
      view.paste(LONG)
    })
    expect(view.chips.begin).toHaveBeenCalledWith(undefined, 'Pasted text')
    expect(mocks.savePastedTextAsFile).toHaveBeenCalledWith({ text: LONG })
    expect(view.chips.attachReferences).toHaveBeenCalledWith([
      { id: 'chip-1', path: '/data/native-chat-pastes/orca-paste-1.txt' }
    ])
    expect(view.insertTypedText).not.toHaveBeenCalled()
  })

  it("saves into the chat's store on its paired server", async () => {
    mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
      ok: true,
      target: {
        environmentId: 'env-1',
        sessionId: 'session-1',
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-a'
      }
    })
    mocks.savePastedTextAsFile.mockResolvedValue('/srv/agent-session-attachments/u1/orca-paste.txt')
    const view = await renderPaste({ owner: sessionOwner })
    await act(async () => {
      view.paste(LONG)
    })
    expect(mocks.savePastedTextAsFile).toHaveBeenCalledWith({
      text: LONG,
      runtimeEnvironmentId: 'env-1',
      agentSessionAttachment: {
        sessionId: 'session-1',
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-a'
      }
    })
    expect(view.chips.attachReferences).toHaveBeenCalledWith([
      { id: 'chip-1', path: '/srv/agent-session-attachments/u1/orca-paste.txt' }
    ])
  })

  it('drops the chip and says why when the file could not be saved', async () => {
    mocks.savePastedTextAsFile.mockRejectedValue(new Error('disk full'))
    const view = await renderPaste({ owner: { kind: 'local' } })
    await act(async () => {
      view.paste(LONG)
    })
    expect(view.chips.drop).toHaveBeenCalledWith('chip-1')
    expect(view.setNotice).toHaveBeenCalledWith(expect.stringContaining('Pasted text'))
    expect(view.chips.attachReferences).not.toHaveBeenCalled()
  })

  it('goes in as text when short, or when the chat is a terminal agent', async () => {
    const structured = await renderPaste({ owner: { kind: 'local' } })
    structured.paste('short')
    expect(structured.insertTypedText).toHaveBeenCalledWith('short')
    act(() => root?.unmount())
    const terminal = await renderPaste({ owner: { kind: 'local' }, structured: false })
    terminal.paste(LONG)
    expect(terminal.insertTypedText).toHaveBeenCalledWith(LONG)
    expect(mocks.savePastedTextAsFile).not.toHaveBeenCalled()
  })

  it("refuses, naming the limit, a paste that could never be sent where files can't attach", async () => {
    const view = await renderPaste({ owner: { kind: 'remote' } })
    view.paste(LONG)
    expect(view.insertTypedText).toHaveBeenCalledWith(LONG)
    view.paste('y'.repeat(256 * 1024))
    expect(view.insertTypedText).toHaveBeenCalledTimes(1)
    expect(view.setNotice).toHaveBeenCalledWith(expect.stringContaining('256 KB limit'))
  })
})
