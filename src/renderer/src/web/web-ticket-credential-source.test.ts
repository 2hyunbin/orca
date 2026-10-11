import { describe, expect, it } from 'vitest'
import { createWebTicketCredentialSource } from './web-ticket-credential-source'
import { resolveWebRuntimeAuthRejection } from './web-runtime-auth-verdict'

const key = { publicKeyB64: 'pub', sign: async () => new Uint8Array(64) }
const ticket = {
  ticket: 'T'.repeat(43),
  deviceId: 'reserved-1',
  key,
  deviceLabel: 'Chrome on macOS',
  ephemeral: false
}

function planOf(source: ReturnType<typeof createWebTicketCredentialSource>) {
  const plan = source.nextPlan(true)
  if (plan instanceof Promise) {
    throw new Error('the ticket source plans synchronously')
  }
  return plan
}

function rejected(errorCode: string, errorDeviceId?: string) {
  return {
    kind: 'rejected' as const,
    type: 'e2ee_error',
    errorCode,
    ...(errorDeviceId ? { errorDeviceId } : {})
  }
}

describe('web ticket credential source', () => {
  it('redeems first, then signs in with the reserved id once the host confirmed it', () => {
    const source = createWebTicketCredentialSource(ticket)
    const first = planOf(source)
    expect(first).toMatchObject({ kind: 'redeem', deviceId: 'reserved-1', ticket: ticket.ticket })
    source.authenticated?.(first)
    expect(source.nextPlan(true)).toMatchObject({ kind: 'device-key', deviceId: 'reserved-1' })
  })

  it('after a lost reply retries key auth first, then redeems again if nothing was committed', async () => {
    const source = createWebTicketCredentialSource(ticket)
    source.nextPlan(true)
    source.redemptionInterrupted?.()
    const keyFirst = planOf(source)
    expect(keyFirst).toMatchObject({ kind: 'device-key', deviceId: 'reserved-1' })
    expect(
      await resolveWebRuntimeAuthRejection(keyFirst, rejected('registry_unavailable'), source)
    ).toEqual({ kind: 'retry' })
    expect(source.nextPlan(true)).toMatchObject({ kind: 'redeem' })
  })

  it('treats device_revoked for the uncommitted reserved id as "redeem again", never as a deleted key', async () => {
    const source = createWebTicketCredentialSource(ticket)
    source.nextPlan(true)
    source.redemptionInterrupted?.()
    const keyFirst = planOf(source)
    expect(
      await resolveWebRuntimeAuthRejection(
        keyFirst,
        rejected('device_revoked', 'reserved-1'),
        source
      )
    ).toEqual({ kind: 'retry' })
    expect(source.nextPlan(true)).toMatchObject({ kind: 'redeem' })
  })

  it('maps every ticket refusal to its own reason', async () => {
    const source = createWebTicketCredentialSource(ticket)
    const plan = planOf(source)
    const cases: [string, string][] = [
      ['approval_denied', 'approval-denied'],
      ['ticket_invalid', 'ticket-invalid'],
      ['ticket_consumed', 'ticket-consumed'],
      ['device_key_in_use', 'device-key-in-use'],
      ['bad_auth', 'ticket-unsupported'],
      ['insecure_origin', 'insecure-origin']
    ]
    for (const [code, reason] of cases) {
      expect(await resolveWebRuntimeAuthRejection(plan, rejected(code), source)).toEqual({
        kind: 'failed',
        reason
      })
    }
  })
})
