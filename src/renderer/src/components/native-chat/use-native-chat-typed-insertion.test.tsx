// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, renderHook, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'

afterEach(cleanup)

// A routed key or a quote, then a key typed before the next animation frame and more after it.
it.each([
  ['insertTypedText', '', 'R', 'e', 'ply', 'Reply'],
  ['appendText', 'Look', '> it\n\n', 'R', 'eply', 'Look\n\n> it\n\nReply']
] as const)(
  'keeps the keys typed right after %s in order',
  async (write, initialValue, written, firstKey, laterKeys, expected) => {
    const inputRef = createRef<NativeChatComposerInput>()
    const view = render(
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue={initialValue}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const editor = promptEditor(within(view.container).getByRole('textbox'))
    const { result } = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: inputRef,
        isComposing: () => false,
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      })
    )
    // The browser types into the now-focused editor at its live selection.
    const typeNatively = (keys: string): void =>
      act(() => {
        for (const key of keys) {
          editor.view.dispatch(editor.state.tr.insertText(key))
        }
      })

    act(() => {
      result.current[write](written)
    })
    typeNatively(firstKey)
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    typeNatively(laterKeys)

    const input = inputRef.current!
    expect([input.value, input.selectionStart]).toEqual([expected, expected.length])
  }
)
