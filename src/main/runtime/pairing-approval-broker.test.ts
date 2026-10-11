import { describe, expect, it, vi } from 'vitest'
import type { PairingApprovalPrompt } from '../../shared/pairing-approval-prompt'
import { PairingApprovalBroker } from './pairing-approval-broker'
import type { PairingTicketApprovalRequest } from './pairing-ticket-redemption'

function request(overrides: Partial<PairingTicketApprovalRequest> = {}) {
  const abort = new AbortController()
  return {
    abort,
    request: {
      ticketId: 'abc',
      scope: 'runtime',
      grants: ['desktop-control'],
      deviceLabel: 'Laptop',
      deviceKeyFingerprint: 'aaaa bbbb cccc dddd',
      comparisonCode: 'KMGVTD',
      replaces: [],
      signal: abort.signal,
      ...overrides
    } satisfies PairingTicketApprovalRequest
  }
}

function isPrompt(value: unknown): value is PairingApprovalPrompt {
  return typeof value === 'object' && value !== null && 'requestId' in value && 'mode' in value
}

function promptAt(sent: { payload: unknown }[], index: number): PairingApprovalPrompt {
  const payload = sent[index]?.payload
  if (!isPrompt(payload)) {
    throw new Error('expected an approval prompt')
  }
  return payload
}

function broker(sendResult = true) {
  const sent: { channel: string; payload: unknown }[] = []
  const send = vi.fn((channel: string, payload: unknown) => {
    sent.push({ channel, payload })
    return sendResult
  })
  return { sent, broker: new PairingApprovalBroker({ send, hostName: () => 'studio-mac' }) }
}

describe('PairingApprovalBroker', () => {
  it('shows the comparison code for a normal pairing and resolves with the owner answer', async () => {
    const { sent, broker: approvals } = broker()
    const pending = approvals.approver(request().request)
    const prompt = promptAt(sent, 0)
    expect(sent[0]?.channel).toBe('pairing:approvalRequested')
    expect(prompt).toMatchObject({
      mode: 'compare',
      comparisonCode: 'KMGVTD',
      hostName: 'studio-mac',
      deviceLabel: 'Laptop',
      grants: ['desktop-control'],
      replaces: []
    })
    expect(approvals.answer({ requestId: prompt.requestId, decision: 'allow' })).toBe(true)
    expect(await pending).toEqual({ decision: 'allow' })
    expect(approvals.answer({ requestId: prompt.requestId, decision: 'allow' })).toBe(false)
  })

  it('never sends the code when approving would replace a device', async () => {
    const { sent, broker: approvals } = broker()
    const pending = approvals.approver(
      request({ replaces: [{ deviceId: 'old', name: 'Laptop' }] }).request
    )
    const prompt = promptAt(sent, 0)
    expect(prompt.mode).toBe('type-to-confirm')
    expect(JSON.stringify(prompt)).not.toContain('KMGVTD')
    expect(prompt.replaces).toEqual(['Laptop'])
    approvals.answer({ requestId: prompt.requestId, decision: 'allow', typedCode: 'kmgvtd' })
    expect(await pending).toEqual({ decision: 'allow', typedCode: 'kmgvtd' })
  })

  it('denies when no window can show the prompt', async () => {
    const { broker: approvals } = broker(false)
    expect(await approvals.approver(request().request)).toEqual({ decision: 'deny' })
  })

  it('denies and closes the dialog when the redemption ends first', async () => {
    const { sent, broker: approvals } = broker()
    const { abort, request: approval } = request()
    const pending = approvals.approver(approval)
    const prompt = promptAt(sent, 0)
    abort.abort()
    expect(await pending).toEqual({ decision: 'deny' })
    expect(sent[1]).toEqual({
      channel: 'pairing:approvalCancelled',
      payload: { requestId: prompt.requestId }
    })
    expect(approvals.answer({ requestId: prompt.requestId, decision: 'allow' })).toBe(false)
  })
})
