// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type * as WebRuntimeEnvironmentModule from './web-runtime-environment'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectWebBrowserWithTicket: vi.fn(),
  saveStoredWebRuntimeEnvironment: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./web-pairing-ticket-connect', () => ({
  connectWebBrowserWithTicket: mocks.connectWebBrowserWithTicket
}))
vi.mock('./web-runtime-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeEnvironmentModule>()),
  readStoredWebRuntimeEnvironment: () => null,
  saveStoredWebRuntimeEnvironment: mocks.saveStoredWebRuntimeEnvironment
}))

import { encodePairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import WebConnect from './WebConnect'

const { code, link } = encodePairingTicketOffer({
  v: 3,
  endpoint: 'ws://192.168.1.20:6768',
  publicKeyB64: Buffer.alloc(32, 4).toString('base64'),
  ticket: Buffer.alloc(32, 9).toString('base64url'),
  deviceId: '1b1f6d1e-6d5f-4b0e-9a49-4c1d2d0f8a11',
  scope: 'runtime',
  expiresAt: 1_800_000_000_000
})

afterEach(() => {
  cleanup()
  mocks.connectWebBrowserWithTicket.mockReset()
  mocks.saveStoredWebRuntimeEnvironment.mockReset()
})

function paste(value: string): void {
  fireEvent.change(screen.getByLabelText('Pairing URL or code'), { target: { value } })
}

describe('WebConnect with a single-use pairing code', () => {
  it('redeems the code and shows the comparison code while the desktop approves', async () => {
    let finish: (environment: unknown) => void = () => {}
    mocks.connectWebBrowserWithTicket.mockImplementation(
      (args: { onComparisonCode: (code: string) => void }) =>
        new Promise((resolve) => {
          args.onComparisonCode('KMGVTD')
          finish = resolve
        })
    )
    const onConnected = vi.fn()
    render(<WebConnect initialPairingInput={null} onConnected={onConnected} />)
    paste(link)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(screen.getByTestId('web-pairing-comparison-code')).toHaveTextContent('KMGVTD')
    )
    await act(async () => finish({ id: 'web-1' }))
    expect(mocks.saveStoredWebRuntimeEnvironment).toHaveBeenCalledWith({ id: 'web-1' })
    expect(onConnected).toHaveBeenCalled()
  })

  it('shows the host refusal and never accepts a ticket inside an orca:// link', async () => {
    mocks.connectWebBrowserWithTicket.mockRejectedValue(
      new Error('This pairing code was already used by another device.')
    )
    render(<WebConnect initialPairingInput={null} onConnected={vi.fn()} />)
    paste(`orca://pair#${code}`)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    paste(code)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/already used by another device/)).toBeInTheDocument()
    expect(mocks.saveStoredWebRuntimeEnvironment).not.toHaveBeenCalled()
  })
})
