import { describe, expect, it } from 'vitest'
import {
  ConnectorDeliverySchema,
  ConnectorPollResponseSchema,
  ConnectorAcksRequestSchema
} from './delivery-messages.js'
import { ConnectorEventSchema, ConnectorReplyResponseSchema } from './event-messages.js'
import { ConnectorHelloRequestSchema } from './hello-messages.js'
import { ConnectorHostSessionResponseSchema } from './host-auth-messages.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorSignInPollResponseSchema } from './sign-in-messages.js'

const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const
const base = { deliveryId: 'T1:C9:1793.0001', seq: 41, expiresAt: 1_793_000_300_000, conversation }
const start = { ...base, kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
const poll = (deliveries: unknown[], extra: object = {}) =>
  ConnectorPollResponseSchema.safeParse({
    v: 1,
    serverNow: 1_793_000_000_000,
    holdMs: 50_000,
    deliveries,
    ...extra
  })

describe('poll response', () => {
  it('parses every known delivery kind and drops unknown fields', () => {
    const result = poll([
      { ...start, addedLater: true },
      { ...base, kind: 'send', text: 'more' },
      { ...base, kind: 'answer', promptId: 'p7', optionId: 'allow_once' },
      { ...base, kind: 'cancel' }
    ])
    expect(result.success && result.data.deliveries.map((d) => d.kind)).toEqual([
      'start',
      'send',
      'answer',
      'cancel'
    ])
    expect(result.data?.deliveries[0]).not.toHaveProperty('addedLater')
    expect(result.data?.control).toBeUndefined()
  })

  it('rejects a delivery the cloud must never send', () => {
    for (const delivery of [
      { ...base, kind: 'rewind' },
      { ...start, prompt: '' },
      { deliveryId: base.deliveryId },
      { ...base, conversation: { source: 'linear', externalId: 'L1' }, kind: 'cancel' }
    ]) {
      expect(ConnectorDeliverySchema.safeParse(delivery).success).toBe(false)
    }
  })

  it('carries one control at a time', () => {
    expect(poll([], { control: { stop: 'host_revoked' } }).data?.control).toEqual({
      stop: 'host_revoked'
    })
    expect(poll([], { control: { pausedForMs: 0 } }).success).toBe(false)
  })

  it('bounds the batch and the hold', () => {
    const tooMany = Array.from({ length: CONNECTOR_LIMITS.maxDeliveriesPerPoll + 1 }, () => start)
    expect(poll(tooMany).success).toBe(false)
    expect(poll([], { holdMs: CONNECTOR_LIMITS.pollTimeoutMs }).success).toBe(false)
  })
})

describe('acks', () => {
  it('accepts received and done with each result outcome', () => {
    const results = [
      { outcome: 'accepted', reopened: true },
      { outcome: 'refused', reason: 'prompt_not_pending' },
      { outcome: 'unknown', reason: 'no_local_record' },
      { outcome: 'expired' },
      { outcome: 'unsupported' }
    ]
    expect(
      ConnectorAcksRequestSchema.safeParse({
        v: 1,
        acks: [
          { deliveryId: 'd1', step: 'received' },
          ...results.map((result) => ({ deliveryId: 'd1', step: 'done', result }))
        ]
      }).success
    ).toBe(true)
    expect(
      ConnectorAcksRequestSchema.safeParse({ v: 1, acks: [{ deliveryId: 'd1', step: 'done' }] })
        .success
    ).toBe(false)
  })
})

describe('events', () => {
  const turnEnded = {
    kind: 'turn-ended',
    conversation,
    paneKey: 'tab:leaf',
    at: 1_793_000_000_000,
    stopReason: null
  }

  it('caps the last assistant message in UTF-8 bytes', () => {
    const limit = CONNECTOR_LIMITS.maxLastAssistantMessageBytes
    expect(
      ConnectorEventSchema.safeParse({ ...turnEnded, lastAssistantMessage: 'a'.repeat(limit) })
        .success
    ).toBe(true)
    expect(
      ConnectorEventSchema.safeParse({ ...turnEnded, lastAssistantMessage: 'é'.repeat(limit / 2 + 1) })
        .success
    ).toBe(false)
  })

  it('carries the pending prompt in snapshots', () => {
    expect(
      ConnectorEventSchema.safeParse({
        kind: 'snapshot',
        conversations: [
          {
            conversation,
            paneKey: 'tab:leaf',
            agent: 'codex',
            working: false,
            prompt: { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
          }
        ]
      }).success
    ).toBe(true)
  })
})

describe('host session', () => {
  it('names the host once and tolerates added fields', () => {
    const session = ConnectorHostSessionResponseSchema.parse({
      sessionToken: Buffer.alloc(32, 3).toString('base64url'),
      expiresAt: 1_793_003_600_000,
      hostId: 'D20lU_8MD0R64gLt',
      addedLater: 1
    })
    expect(Object.keys(session)).toEqual(['sessionToken', 'expiresAt', 'hostId'])
  })
})

describe('sign-in and hello', () => {
  it('requires the host id and account only once authorized', () => {
    expect(ConnectorSignInPollResponseSchema.safeParse({ status: 'pending', interval: 5 }).success).toBe(
      true
    )
    expect(
      ConnectorSignInPollResponseSchema.safeParse({ status: 'authorized', interval: 5 }).success
    ).toBe(false)
  })

  it('keeps capability entries the cloud does not know', () => {
    const hello = ConnectorHelloRequestSchema.parse({
      v: 1,
      helloRev: 7,
      contract: 1,
      orcaVersion: '1.4.230',
      platform: 'linux',
      runtime: 'serve',
      hostName: 'build-box',
      agents: ['claude', 'future-agent'],
      promptKinds: ['approval'],
      features: ['answer', 'future-feature'],
      projects: [
        { placeId: 'pl_1', name: 'orca', kind: 'git', where: { kind: 'ssh', label: 'openclaw' } }
      ]
    })
    expect(hello.features).toEqual(['answer', 'future-feature'])
  })

  it('reads a reply as posted or queued', () => {
    expect(ConnectorReplyResponseSchema.parse({ status: 'queued' })).toEqual({ status: 'queued' })
  })
})
