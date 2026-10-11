// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createLocalPairingTicket: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

import { SingleUsePairingCodeButton } from './SingleUsePairingCodeButton'

describe('SingleUsePairingCodeButton', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: { createLocalPairingTicket: mocks.createLocalPairingTicket },
        ui: { writeClipboardText: mocks.writeClipboardText }
      }
    })
  })
  afterEach(() => cleanup())

  it('mints a ticket for the selected address and copies only its code', async () => {
    mocks.createLocalPairingTicket.mockResolvedValue({
      available: true,
      ticketId: 'abc',
      code: 'eyJ2IjozfQ',
      link: 'https://www.onorca.dev/pair#eyJ2IjozfQ',
      expiresAt: 1
    })
    render(<SingleUsePairingCodeButton address="192.168.1.20" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy single-use pairing code' }))
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith('eyJ2IjozfQ'))
    expect(mocks.createLocalPairingTicket).toHaveBeenCalledWith({ address: '192.168.1.20' })
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('shows the host guidance when a ticket cannot be minted', async () => {
    mocks.createLocalPairingTicket.mockResolvedValue({ available: false, guidance: 'Port busy.' })
    render(<SingleUsePairingCodeButton address="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy single-use pairing code' }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Port busy.'))
    expect(mocks.createLocalPairingTicket).toHaveBeenCalledWith(undefined)
    expect(mocks.writeClipboardText).not.toHaveBeenCalled()
  })
})
