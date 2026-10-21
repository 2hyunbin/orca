// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, isInaccessible, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSleepingPaneOverlay } from './TerminalSleepingPaneOverlay'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('TerminalSleepingPaneOverlay', () => {
  it.each([
    [undefined, undefined],
    [null, "The pause reason isn't available."],
    ['unclean_host_death', 'after Orca’s terminal service stopped unexpectedly.'],
    ['pressure', 'after rapid growth in running programs.'],
    ['operator', 'was paused manually.']
  ] as const)(
    'explains the reported pause %s without inventing a cause while pending',
    (observedPauseReason, detail) => {
      render(
        <TerminalSleepingPaneOverlay
          reason="paused"
          observedPauseReason={observedPauseReason}
          onResume={vi.fn()}
        />
      )

      expect(screen.getByText('Resume your session')).toBeInTheDocument()
      expect(screen.getByText('This session did not reopen automatically.')).toBeInTheDocument()
      expect(screen.getByText('Use Resume to open this session.')).toBeInTheDocument()
      const automaticGuidance = screen.getByText(/Use Resume automatic restores/)
      expect(automaticGuidance).toHaveClass('invisible')
      expect(automaticGuidance).toHaveAttribute('aria-hidden', 'true')
      expect(isInaccessible(automaticGuidance)).toBe(true)
      if (detail) {
        expect(screen.getByText((text) => text.endsWith(detail))).toHaveAttribute(
          'aria-hidden',
          'false'
        )
      } else {
        expect(screen.getByText("The pause reason isn't available.")).toHaveAttribute(
          'aria-hidden',
          'true'
        )
      }
      expect(
        screen.getByText(/Your conversation is saved. Resume whenever you’re ready./)
      ).toBeInTheDocument()
    }
  )

  it('resumes once from the button and from anywhere on the pane', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<TerminalSleepingPaneOverlay reason="live_cap" onResume={onResume} />)

    expect(
      screen.getByText(
        'Orca has reached its limit for reopening sessions on the computer running this session.'
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledOnce()
    await user.click(screen.getByText('Resume your session'))
    expect(onResume).toHaveBeenCalledTimes(2)
  })

  it('offers to resume automatic restores only when the host can clear its pause', async () => {
    const onResume = vi.fn()
    const onResumeAutomaticRestores = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<TerminalSleepingPaneOverlay reason="paused" onResume={onResume} />)
    expect(screen.queryByRole('button', { name: 'Resume automatic restores' })).toBeNull()
    const automaticGuidance = screen.getByText(/Use Resume automatic restores/)
    expect(automaticGuidance).toHaveClass('invisible')
    expect(automaticGuidance).toHaveAttribute('aria-hidden', 'true')
    expect(isInaccessible(automaticGuidance)).toBe(true)

    rerender(
      <TerminalSleepingPaneOverlay
        reason="paused"
        onResume={onResume}
        onResumeAutomaticRestores={onResumeAutomaticRestores}
      />
    )
    expect(screen.getByText(/Use Resume automatic restores/)).toBe(automaticGuidance)
    expect(automaticGuidance).not.toHaveClass('invisible')
    expect(automaticGuidance).toHaveAttribute('aria-hidden', 'false')
    expect(automaticGuidance).toBeVisible()
    expect(isInaccessible(automaticGuidance)).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Resume automatic restores' }))
    expect(onResumeAutomaticRestores).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()
  })
})
