import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyLinearWebhook } from './linear-signature.js'

// Linear publishes no test vectors; these sign with a self-generated secret per
// https://linear.app/developers/webhooks#securing-webhooks
describe('verifyLinearWebhook', () => {
  const secret = 'lin_wh_test_secret'
  const deliveryId = '0d3c7a52-6f1e-4c55-9f0b-2f4f3b8f9d11'
  const nowMs = 1_800_000_000_000
  const body = JSON.stringify({ type: 'AgentSessionEvent', webhookTimestamp: nowMs })
  const sign = (key: string, raw: string) => createHmac('sha256', key).update(raw).digest('hex')
  const check = (overrides: Partial<Parameters<typeof verifyLinearWebhook>[0]> = {}) =>
    verifyLinearWebhook({
      signingSecret: secret,
      signature: sign(secret, body),
      deliveryId,
      rawBody: body,
      nowMs,
      ...overrides
    })

  it('accepts a signed body within a minute and returns the delivery id', () => {
    expect(check()).toEqual({ deliveryId, payload: JSON.parse(body) })
    expect(check({ nowMs: nowMs + 60_000 })).not.toBeNull()
    expect(check({ nowMs: nowMs - 60_000 })).not.toBeNull()
    expect(check({ signature: sign(secret, body).toUpperCase() })).not.toBeNull()
  })

  it('refuses another secret, a re-serialized body, or a malformed signature', () => {
    expect(check({ signature: sign('other', body) })).toBeNull()
    const reserialized = JSON.stringify(JSON.parse(body), null, 2)
    expect(check({ rawBody: reserialized })).toBeNull()
    expect(check({ signature: undefined })).toBeNull()
    expect(check({ signature: 'abc' })).toBeNull()
    expect(check({ signature: `sha256=${sign(secret, body)}` })).toBeNull()
  })

  it('refuses a stale or missing signed timestamp', () => {
    expect(check({ nowMs: nowMs + 60_001 })).toBeNull()
    expect(check({ nowMs: nowMs - 60_001 })).toBeNull()
    const untimed = JSON.stringify({ type: 'AgentSessionEvent' })
    expect(check({ rawBody: untimed, signature: sign(secret, untimed) })).toBeNull()
  })

  it('refuses a missing or malformed delivery id', () => {
    expect(check({ deliveryId: undefined })).toBeNull()
    expect(check({ deliveryId: 'not-a-uuid' })).toBeNull()
  })

  it('refuses a signed body that is not JSON', () => {
    expect(check({ rawBody: 'nope', signature: sign(secret, 'nope') })).toBeNull()
  })
})
