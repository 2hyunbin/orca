// @vitest-environment happy-dom

import { cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import {
  structuredAgentSessionQueueRequest,
  type StructuredAgentSessionSendIntent
} from './structured-agent-session-queue-request'

const platform = vi.hoisted(() => ({ isMac: true }))
vi.mock('./native-chat-shortcut', () => ({ isMacPlatform: () => platform.isMac }))
afterEach(cleanup)

it.each([true, false])(
  'separates draft delivery from the first-card command (Mac: %s)',
  (isMac) => {
    platform.isMac = isMac
    const steerQueued = vi.fn(() => true)
    const send = vi.fn((intent?: StructuredAgentSessionSendIntent) =>
      structuredAgentSessionQueueRequest({ capability: 'supported', enabled: queue }, [], intent)
    )
    let queue = true
    const hook = renderHook(
      ({ draft }) =>
        useNativeChatComposerKeyDown({
          autocomplete: { mode: 'none' },
          mentionFiles: { files: [], loading: false, failed: false },
          completeMention: vi.fn(),
          activeSuggestion: 0,
          draft,
          isComposing: () => false,
          completePickerItem: vi.fn(),
          dispatchPickerCommand: vi.fn(),
          dismissPicker: vi.fn(),
          interrupt: vi.fn(),
          send,
          steerQueued,
          setActiveSuggestion: vi.fn(),
          setDraft: vi.fn(),
          setCaret: vi.fn()
        }),
      { initialProps: { draft: 'unfinished draft' } }
    )
    const view = render(<textarea onKeyDown={hook.result.current} />)
    const field = view.container.querySelector('textarea')!
    const mod = isMac ? { metaKey: true } : { ctrlKey: true }
    const press = (modifiers: KeyboardEventInit = {}) =>
      fireEvent.keyDown(field, { key: 'Enter', ...modifiers })

    for (queue of [true, false]) {
      press()
      expect(send.mock.results.at(-1)?.value).toBe(queue ? 'queue-if-active' : undefined)
      press(mod)
      expect(send.mock.results.at(-1)?.value).toBe(queue ? undefined : 'queue-if-active')
    }
    press({ ...mod, shiftKey: true })
    expect(steerQueued).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(4)
    press({ ...mod, shiftKey: true, repeat: true })
    press({ ...mod, repeat: true })
    press({ shiftKey: true })
    expect(steerQueued).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(4)

    hook.rerender({ draft: '' })
    view.rerender(<textarea onKeyDown={hook.result.current} />)
    press(mod)
    press()
    expect(send).toHaveBeenCalledTimes(4)
    expect(steerQueued).toHaveBeenCalledOnce()
  }
)
