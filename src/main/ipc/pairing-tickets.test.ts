import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

import { PairingApprovalBroker } from '../runtime/pairing-approval-broker'
import { registerPairingTicketHandlers } from './pairing-tickets'

type Handler = (event: { sender: string }, args?: unknown) => unknown

function setup(options: { trusted?: boolean; exposureFails?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  handleMock.mockImplementation((channel: string, handler: Handler) =>
    handlers.set(channel, handler)
  )
  const prompts: { requestId: string }[] = []
  const broker = new PairingApprovalBroker({
    send: (channel, payload) => {
      if (
        channel === 'pairing:approvalRequested' &&
        payload &&
        typeof payload === 'object' &&
        'requestId' in payload &&
        typeof payload.requestId === 'string'
      ) {
        prompts.push({ requestId: payload.requestId })
      }
      return true
    },
    hostName: () => 'studio-mac'
  })
  const runtime = {
    createLocalUiPairingTicket: vi.fn(() => ({
      available: true as const,
      ticketId: 'abc123abc123',
      code: 'code',
      link: 'https://www.onorca.dev/pair#code',
      expiresAt: 1
    })),
    ensureNetworkExposure: vi.fn(async () => {
      if (options.exposureFails) {
        throw new Error('bind failed')
      }
    })
  }
  registerPairingTicketHandlers(runtime, broker, {
    isTrustedSender: (event) => (options.trusted ?? true) && event.sender === 'main',
    getDefaultRouteInterfaceNames: async () => null
  })
  const invoke = (channel: string, args?: unknown, sender = 'main') =>
    handlers.get(channel)!({ sender }, args)
  return { broker, runtime, prompts, invoke }
}

const approval = {
  ticketId: 'abc',
  scope: 'runtime' as const,
  grants: [],
  deviceLabel: 'Laptop',
  deviceKeyFingerprint: 'aaaa bbbb cccc dddd',
  comparisonCode: 'KMGVTD',
  replaces: []
}

describe('pairing ticket IPC', () => {
  beforeEach(() => handleMock.mockReset())

  it('answers an approval only from the main window, with a valid shape', async () => {
    const { broker, prompts, invoke } = setup()
    const pending = broker.approver({ ...approval, signal: new AbortController().signal })
    const requestId = prompts[0]!.requestId
    expect(await invoke('pairing:answerApproval', { requestId, decision: 'allow' }, 'other')).toBe(
      false
    )
    expect(await invoke('pairing:answerApproval', { requestId, decision: 'maybe' })).toBe(false)
    expect(await invoke('pairing:answerApproval', { requestId, decision: 'deny' })).toBe(true)
    expect(await pending).toEqual({ decision: 'deny' })
  })

  it('mints a local-UI ticket for the chosen address after widening the listener', async () => {
    const { runtime, invoke } = setup()
    expect(await invoke('pairing:createLocalTicket', { address: '192.168.1.20' })).toMatchObject({
      available: true,
      link: 'https://www.onorca.dev/pair#code'
    })
    expect(runtime.ensureNetworkExposure).toHaveBeenCalledOnce()
    expect(runtime.createLocalUiPairingTicket).toHaveBeenCalledWith('192.168.1.20')
  })

  it('refuses to mint for an untrusted renderer or when the listener cannot widen', async () => {
    expect(await setup({ trusted: false }).invoke('pairing:createLocalTicket', {})).toEqual({
      available: false
    })
    const failing = setup({ exposureFails: true })
    expect(
      await failing.invoke('pairing:createLocalTicket', { address: '192.168.1.20' })
    ).toMatchObject({ available: false, guidance: expect.any(String) })
    expect(failing.runtime.createLocalUiPairingTicket).not.toHaveBeenCalled()
  })
})
