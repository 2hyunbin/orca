// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerActions } from './NativeChatComposerActions'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./NativeChatSessionOptionPickers', () => ({ NativeChatSessionOptionPickers: () => null }))
vi.mock('./NativeChatPermissionModePicker', () => ({
  NativeChatComposerPermissionPicker: () => null
}))

afterEach(cleanup)

describe('working follow-up Stop tooltip', () => {
  it.each(['keyboard focus', 'pointer hover'])(
    'names the separate Stop on %s without changing its action',
    async (interaction) => {
      const onStop = vi.fn()
      const onSend = vi.fn()
      render(
        <TooltipProvider delayDuration={0}>
          <NativeChatComposerActions
            attachDisabled={false}
            dictationDisabled
            sendDisabled={false}
            isWorking
            hasDraft
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
        </TooltipProvider>
      )
      const stop = screen.getByRole('button', { name: 'Stop the agent' })
      if (interaction === 'keyboard focus') {
        act(() => stop.focus())
      } else {
        fireEvent.pointerMove(stop, { pointerType: 'mouse' })
      }

      expect(await screen.findByRole('tooltip')).toHaveTextContent('Stop the agent')
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
      fireEvent.click(stop)
      expect(onStop).toHaveBeenCalledOnce()
      expect(onSend).not.toHaveBeenCalled()
    }
  )
})
