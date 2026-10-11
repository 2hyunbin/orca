import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { PairingTicketBook } from '../pairing-ticket-book'
import { createOwnerPairingTicketContext } from '../runtime-rpc/runtime-rpc-pairing-ticket-owner'
import { decodePairingTicketCode } from '../../../shared/pairing-ticket-offer'
import { buildVerifiedPairingLink } from '../../../shared/verified-pairing-link'
import type { RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import type { RpcCallerScope } from './rpc-caller-scope'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'

const HOST_KEY = Buffer.alloc(32, 3).toString('base64')

function ownerContext(tickets = new PairingTicketBook()) {
  return createOwnerPairingTicketContext({
    tickets,
    resolveHost: () => ({
      available: true,
      endpoint: 'ws://192.168.1.20:6768',
      publicKeyB64: HOST_KEY,
      hostDescriptor: null
    })
  })
}

function dispatch(method: string, params: unknown, options?: RpcDispatchStreamingOptions) {
  return new RpcDispatcher({ runtime: new OrcaRuntimeService() }).dispatch(
    { id: 'req', authToken: 'unused', method, params },
    options
  )
}

function result<T>(response: RpcResponse): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}

describe('pairing ticket RPCs', () => {
  it('lets the owner mint, list and revoke tickets without ever listing the secret', async () => {
    const pairingTickets = ownerContext()
    const created = result<{ ticketId: string; code: string; link: string; expiresAt: number }>(
      await dispatch('pairing.createTicket', { ttlMs: 15 * 60_000 }, { pairingTickets })
    )
    const offer = decodePairingTicketCode(created.code)
    expect(offer).toMatchObject({ v: 3, scope: 'runtime', publicKeyB64: HOST_KEY })
    expect(created.link).toBe(buildVerifiedPairingLink(created.code))

    const listed = await dispatch('pairing.listTickets', undefined, { pairingTickets })
    expect(JSON.stringify(listed)).not.toContain(offer!.ticket)
    expect(result<{ tickets: { ticketId: string }[] }>(listed).tickets).toEqual([
      expect.objectContaining({ ticketId: created.ticketId, issuedVia: 'owner-cli' })
    ])
    expect(
      result(
        await dispatch('pairing.revokeTicket', { ticketId: created.ticketId }, { pairingTickets })
      )
    ).toEqual({ revoked: true })
  })

  it('rejects a lifetime above one hour', async () => {
    const response = await dispatch(
      'pairing.createTicket',
      { ttlMs: 60 * 60_000 + 1 },
      { pairingTickets: ownerContext() }
    )
    expect(response.ok).toBe(false)
  })

  it('is unreachable from every paired caller, even if a context leaked', async () => {
    const scopes: RpcCallerScope[] = [
      { kind: 'runtime-paired', grants: ['desktop-control'] },
      { kind: 'mobile' },
      { kind: 'mobile', delegated: true }
    ]
    for (const callerScope of scopes) {
      const response = await dispatch(
        'pairing.createTicket',
        {},
        { callerScope, pairingTickets: ownerContext() }
      )
      expect(response.ok ? null : response.error.code, callerScope.kind).toBe('forbidden')
    }
  })

  it('refuses a caller that has no owner ticket context', async () => {
    const response = await dispatch('pairing.createTicket', {})
    expect(response.ok).toBe(false)
  })
})
