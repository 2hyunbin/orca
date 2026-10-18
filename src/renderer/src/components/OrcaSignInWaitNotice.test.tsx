// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaSignInWaitNotice } from './OrcaSignInWaitNotice'

const mocks = vi.hoisted(() => ({
  pending: false,
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: { orcaProfileSignInPending: boolean }) => unknown) =>
    selector({ orcaProfileSignInPending: mocks.pending })
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('OrcaSignInWaitNotice', () => {
  const pendingSignInLink = vi.fn()
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    mocks.pending = true
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    pendingSignInLink.mockReset()
    writeClipboardText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { orcaProfiles: { pendingSignInLink }, ui: { writeClipboardText } }
    })
  })

  afterEach(() => cleanup())

  it('renders nothing when no sign-in is waiting', () => {
    mocks.pending = false
    const { container } = render(<OrcaSignInWaitNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('copies the waiting sign-in link', async () => {
    pendingSignInLink.mockResolvedValue('https://login.example/authorize?state=abc')
    render(<OrcaSignInWaitNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for sign-in in your browser')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(writeClipboardText).toHaveBeenCalledWith('https://login.example/authorize?state=abc')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sign-in link copied')
  })

  it('reports a failed copy when the wait has no link to copy', async () => {
    pendingSignInLink.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<OrcaSignInWaitNotice />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not copy the link.')
  })
})
