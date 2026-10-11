// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingApprovalPrompt } from '../../../../shared/pairing-approval-prompt'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

import { PAIRING_APPROVAL_ARMING_DELAY_MS, PairingApprovalDialog } from './PairingApprovalDialog'
import { PairingApprovalHost } from './PairingApprovalHost'

const base = {
  requestId: '6f1f9b1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  hostName: 'studio-mac',
  scope: 'runtime' as const,
  grants: [],
  deviceLabel: 'Laptop browser',
  deviceKeyFingerprint: 'aaaa bbbb cccc dddd',
  replaces: []
}
const compare: PairingApprovalPrompt = { ...base, mode: 'compare', comparisonCode: 'KMGVTD' }
const replacement: PairingApprovalPrompt = {
  ...base,
  mode: 'type-to-confirm',
  replaces: ['Laptop browser']
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function arm(): void {
  act(() => {
    vi.advanceTimersByTime(PAIRING_APPROVAL_ARMING_DELAY_MS)
  })
}

describe('PairingApprovalDialog', () => {
  it('keeps Allow disarmed briefly, so a click meant for a withdrawn prompt cannot approve this one', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(<PairingApprovalDialog prompt={compare} onAnswer={onAnswer} />)
    const allow = screen.getByRole('button', { name: 'Allow' })
    expect(allow).toBeDisabled()
    fireEvent.click(allow)
    expect(onAnswer).not.toHaveBeenCalled()
    arm()
    expect(allow).toBeEnabled()
  })

  it('shows host, authority, device, key and the code, and allows on request', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(
      <PairingApprovalDialog
        prompt={{ ...compare, grants: ['desktop-control'] }}
        onAnswer={onAnswer}
      />
    )
    expect(screen.getByText('Allow a new device to pair with studio-mac?')).toBeInTheDocument()
    expect(screen.getByText(/run commands, open terminals/)).toHaveTextContent(
      "control this computer's screen and keyboard"
    )
    expect(screen.getByText('Laptop browser')).toBeInTheDocument()
    expect(screen.getByText('aaaa bbbb cccc dddd')).toBeInTheDocument()
    expect(screen.getByTestId('pairing-comparison-code')).toHaveTextContent('KMGVTD')
    arm()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onAnswer).toHaveBeenCalledWith({ requestId: base.requestId, decision: 'allow' })
  })

  it('denies when the owner clicks Deny or closes the dialog', () => {
    const onAnswer = vi.fn()
    render(<PairingApprovalDialog prompt={compare} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onAnswer).toHaveBeenCalledWith({ requestId: base.requestId, decision: 'deny' })
    expect(onAnswer.mock.calls.every(([answer]) => answer.decision === 'deny')).toBe(true)
  })

  it('makes the owner type the device code before a replacement, never showing it', () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    render(<PairingApprovalDialog prompt={replacement} onAnswer={onAnswer} />)
    expect(screen.queryByTestId('pairing-comparison-code')).toBeNull()
    expect(screen.getByText(/replaces Laptop browser/)).toBeInTheDocument()
    const allow = screen.getByRole('button', { name: 'Allow' })
    arm()
    expect(allow).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type the code shown on the new device'), {
      target: { value: 'kmg-vtd' }
    })
    expect(allow).toBeEnabled()
    fireEvent.click(allow)
    expect(onAnswer).toHaveBeenCalledWith({
      requestId: base.requestId,
      decision: 'allow',
      typedCode: 'kmg-vtd'
    })
  })
})

describe('PairingApprovalHost', () => {
  it('shows host prompts one at a time, drops withdrawn ones and sends answers', () => {
    vi.useFakeTimers()
    let requested: (prompt: PairingApprovalPrompt) => void = () => {}
    let cancelled: (detail: { requestId: string }) => void = () => {}
    const answerPairingApproval = vi.fn(async () => true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          onPairingApprovalRequested: (callback: typeof requested) => {
            requested = callback
            return () => {}
          },
          onPairingApprovalCancelled: (callback: typeof cancelled) => {
            cancelled = callback
            return () => {}
          },
          answerPairingApproval
        }
      }
    })
    render(<PairingApprovalHost />)
    expect(screen.queryByRole('dialog')).toBeNull()

    const second = {
      ...compare,
      requestId: '7f1f9b1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
      deviceLabel: 'Tablet'
    }
    act(() => {
      requested(compare)
      requested(second)
    })
    expect(screen.getByText('Laptop browser')).toBeInTheDocument()
    act(() => cancelled({ requestId: compare.requestId }))
    expect(screen.getByText('Tablet')).toBeInTheDocument()
    arm()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(answerPairingApproval).toHaveBeenCalledWith({
      requestId: second.requestId,
      decision: 'allow'
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
