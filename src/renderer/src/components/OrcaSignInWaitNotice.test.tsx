// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { OrcaSignInWaitNotice } from './OrcaSignInWaitNotice'

const mocks = vi.hoisted((): { link: string | null; toastError: Mock; toastSuccess: Mock } => ({
  link: null,
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: { orcaProfileSignInLink: string | null }) => unknown) =>
    selector({ orcaProfileSignInLink: mocks.link })
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('OrcaSignInWaitNotice', () => {
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    mocks.link = 'https://login.example/authorize?state=abc'
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    writeClipboardText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => cleanup())

  it('renders nothing when no sign-in is waiting', () => {
    mocks.link = null
    const { container } = render(<OrcaSignInWaitNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('copies the waiting sign-in link', async () => {
    render(<OrcaSignInWaitNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for sign-in in your browser')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(writeClipboardText).toHaveBeenCalledWith('https://login.example/authorize?state=abc')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sign-in link copied')
  })

  it('reports a failed clipboard write', async () => {
    writeClipboardText.mockRejectedValue(new Error('denied'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<OrcaSignInWaitNotice />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(mocks.toastError).toHaveBeenCalledWith('Could not copy the link.')
  })
})
