// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const voice = vi.hoisted(() => ({
  dictationState: 'idle',
  settings: { voice: { enabled: true, sttModel: 'configured' } }
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof voice) => unknown) => selector(voice)
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode
    variant?: string
    size?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))

import { NativeChatComposerActions } from './NativeChatComposerActions'
import { useNativeChatDictation } from './use-native-chat-dictation'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

afterEach(() => {
  cleanup()
  voice.dictationState = 'idle'
  vi.clearAllMocks()
})

describe('NativeChatComposerActions', () => {
  describe('working follow-ups', () => {
    const props = {
      attachDisabled: false,
      dictationDisabled: false,
      sendDisabled: false,
      isWorking: true,
      hasDraft: true,
      isDictating: false,
      isDictationHoldMode: false,
      onAttach: vi.fn(),
      onDictationToggle: vi.fn(),
      onDictationHoldStart: vi.fn(),
      onDictationHoldEnd: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      sessionOptionsSurface: null,
      sessionOptionsSnapshot: []
    }

    it('sends the follow-up without stopping, with Stop still available separately', () => {
      render(<NativeChatComposerActions {...props} />)

      const send = screen.getByRole('button', { name: 'Send' })
      expect(fireEvent.mouseDown(send)).toBe(false)
      fireEvent.click(send)
      expect(props.onSend).toHaveBeenCalledOnce()
      expect(props.onStop).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
      expect(props.onStop).toHaveBeenCalledOnce()
    })

    it('keeps Stop enabled when an attachment blocks sending the follow-up', () => {
      render(
        <NativeChatComposerActions
          {...props}
          sendDisabled
          sendBlockedReason="Remove the unavailable image to send."
        />
      )

      expect(
        screen
          .getByRole('button', { name: 'Remove the unavailable image to send.' })
          .hasAttribute('disabled')
      ).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
      expect(props.onStop).toHaveBeenCalledOnce()
      expect(props.onSend).not.toHaveBeenCalled()
    })

    it('can queue a follow-up while Stop is pending or unavailable', () => {
      const { rerender } = render(<NativeChatComposerActions {...props} isStopping />)
      expect(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(props.onSend).toHaveBeenCalledOnce()

      rerender(<NativeChatComposerActions {...props} stopDisabled />)
      expect(screen.getByRole('button', { name: 'Stop the agent' }).hasAttribute('disabled')).toBe(
        true
      )
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
    })

    it('returns to Stop only after the draft is sent and ignores a second click', () => {
      const { rerender } = render(<NativeChatComposerActions {...props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 })

      rerender(<NativeChatComposerActions {...props} hasDraft={false} sendDisabled />)
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }), { detail: 2 })
      expect(props.onSend).toHaveBeenCalledOnce()
      expect(props.onStop).not.toHaveBeenCalled()
    })
  })

  it.each(['starting', 'listening'])('blocks new dictation but preserves %s Stop', (state) => {
    const input = document.createElement('textarea')
    const focus = vi.spyOn(input, 'focus')
    const { result, rerender } = renderHook(
      (disabled: boolean) => useNativeChatDictation({ current: input }, disabled),
      { initialProps: true }
    )
    act(() => {
      result.current.toggleDictation()
      result.current.startHoldDictation()
    })
    expect(dispatchDictationControl).not.toHaveBeenCalled()
    rerender(false)
    act(() => result.current.startHoldDictation())
    expect(dispatchDictationControl).toHaveBeenLastCalledWith('start')
    voice.dictationState = state
    rerender(true)
    expect(result.current.dictationDisabled).toBe(false)
    focus.mockClear()
    act(() => {
      result.current.toggleDictation()
      result.current.stopHoldDictation()
    })
    expect(dispatchDictationControl).toHaveBeenLastCalledWith('stop')
    expect(focus).not.toHaveBeenCalled()
  })

  it("disables the Stop control and names it Stopping while a person's Stop is ending the turn", () => {
    const props = {
      attachDisabled: false,
      dictationDisabled: false,
      isWorking: true,
      isDictating: false,
      isDictationHoldMode: false,
      onAttach: vi.fn(),
      onDictationToggle: vi.fn(),
      onDictationHoldStart: vi.fn(),
      onDictationHoldEnd: vi.fn(),
      onSend: vi.fn(),
      sessionOptionsSurface: null,
      sessionOptionsSnapshot: []
    }
    const { rerender } = render(<NativeChatComposerActions {...props} sendDisabled={false} />)
    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeTruthy()

    rerender(<NativeChatComposerActions {...props} sendDisabled={false} isStopping />)

    expect(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled')).toBe(true)
  })

  it('marks the streaming Stop control as the critical hit target', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    expect(
      screen
        .getByRole('button', { name: 'Stop the agent' })
        .getAttribute('data-native-chat-critical-action')
    ).toBe('stop')
  })

  it('ignores the second click of a double-click after send becomes Stop', () => {
    const onSend = vi.fn()
    const onStop = vi.fn()
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled={false}
        isWorking
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={onSend}
        onStop={onStop}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }), { detail: 2 })

    expect(onSend).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'a press on Send or Stop leaves focus where it was (working: %s)',
    (isWorking) => {
      render(
        <NativeChatComposerActions
          attachDisabled={false}
          dictationDisabled={false}
          sendDisabled={false}
          isWorking={isWorking}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={vi.fn()}
          onDictationToggle={vi.fn()}
          onDictationHoldStart={vi.fn()}
          onDictationHoldEnd={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
        />
      )

      const button = screen.getByRole('button', { name: isWorking ? 'Stop the agent' : 'Send' })
      // fireEvent returns false when the default (moving focus to the button) was prevented.
      expect(fireEvent.mouseDown(button)).toBe(false)
    }
  )

  it('says on the disabled send button what to do to send', () => {
    render(
      <NativeChatComposerActions
        attachDisabled={false}
        dictationDisabled={false}
        sendDisabled
        sendBlockedReason="An image couldn't be brought back. Remove it to send."
        isWorking={false}
        isDictating={false}
        isDictationHoldMode={false}
        onAttach={vi.fn()}
        onDictationToggle={vi.fn()}
        onDictationHoldStart={vi.fn()}
        onDictationHoldEnd={vi.fn()}
        onSend={vi.fn()}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
    )

    const send = screen.getByRole('button', {
      name: "An image couldn't be brought back. Remove it to send."
    })
    expect(send.hasAttribute('disabled')).toBe(true)
  })

  it('marks a draft that could not be saved only after storage refused it', () => {
    const props = {
      attachDisabled: false,
      dictationDisabled: false,
      sendDisabled: false,
      isWorking: false,
      isDictating: false,
      isDictationHoldMode: false,
      onAttach: vi.fn(),
      onDictationToggle: vi.fn(),
      onDictationHoldStart: vi.fn(),
      onDictationHoldEnd: vi.fn(),
      onSend: vi.fn(),
      sessionOptionsSurface: null,
      sessionOptionsSnapshot: []
    }
    const explanation = "This draft couldn't be saved yet. Orca keeps trying."
    const { rerender } = render(<NativeChatComposerActions {...props} />)
    expect(screen.queryByRole('img', { name: explanation })).toBeNull()

    rerender(<NativeChatComposerActions {...props} draftNotSaved />)
    expect(screen.getByRole('img', { name: explanation })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
  })
})
