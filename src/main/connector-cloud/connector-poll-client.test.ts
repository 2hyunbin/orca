import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import type { Delivery } from '../external-conversations/external-conversation-types'
import {
  connectorHostId,
  keypairFromSecret,
  type ConnectorHostIdentity
} from './connector-host-identity'
import { connectorProjects } from './connector-places'
import { ConnectorPollClient } from './connector-poll-client'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const SERVER_NOW = 1_800_000_000_000
const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const
const [project] = connectorProjects({
  getRepos: () => [
    { id: 'orca', path: '/src/orca', displayName: 'orca', badgeColor: '#000', addedAt: 1 }
  ],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSshTargets: () => [],
  getProjectHostSetups: () => []
})

let userDataPath: string
let fake: FakeConnectorCloud
let identity: ConnectorHostIdentity

function startClient(seam = fakeSeam()) {
  const onRevoked = vi.fn()
  const client = new ConnectorPollClient({
    origin: fake.origin,
    userDataPath,
    identity,
    seam: seam.seam,
    machine: fakeMachine(() => seam, [project!]),
    onRevoked,
    fetchImpl: fake.fetch,
    random: () => 0.5
  })
  client.start()
  return { client, onRevoked, ...seam }
}

// Each step lets a chain of fetches and seam answers run to its next timer.
const settle = async (ms = 0): Promise<void> => {
  for (let step = 0; step < 50; step++) {
    await vi.advanceTimersByTimeAsync(ms / 50)
  }
}

function poll(deliveries: unknown[], extra: Record<string, unknown> = {}) {
  fake.answerPoll({
    status: 200,
    body: { v: 1, serverNow: SERVER_NOW, holdMs: 50_000, deliveries, ...extra }
  })
}

const base = { seq: 1, expiresAt: SERVER_NOW + 300_000, conversation }

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    now: SERVER_NOW
  })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-client-'))
  fake = new FakeConnectorCloud()
  const keypair = keypairFromSecret(nacl.box.keyPair().secretKey)
  const hostId = connectorHostId(keypair)
  identity = { keypair, link: { hostId, email: 'ada@example.com', hostName: 'box', linkedAt: 1 } }
  fake.linked.set(hostId, 'ada@example.com')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorPollClient', () => {
  it('says hello with capabilities and projects, then sends the snapshot', async () => {
    const { client } = startClient()
    await settle()
    expect(fake.hellos[0]).toMatchObject({
      v: 1,
      contract: 1,
      runtime: 'serve',
      hostName: 'box',
      agents: ['claude', 'codex'],
      promptKinds: ['approval', 'question'],
      features: ['answer', 'cancel'],
      projects: [{ placeId: project!.placeId, name: 'orca', kind: 'git' }]
    })
    expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    client.stop()
  })

  it('confirms received right after the seam call, then done with its result', async () => {
    const seam = fakeSeam()
    const sent = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d2', sent.promise)
    const { client, calls } = startClient(seam)
    await settle()
    poll([
      {
        ...base,
        deliveryId: 'd1',
        kind: 'start',
        agent: 'claude',
        placeId: project!.placeId,
        prompt: 'fix it'
      },
      { ...base, deliveryId: 'd2', kind: 'send', text: 'more' }
    ])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(expect.anything(), conversation, 'd1', {
      agent: 'claude',
      prompt: 'fix it',
      target: expect.objectContaining({ kind: 'create-worktree' })
    })
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd2', step: 'received' },
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
    ])
    sent.resolve({ outcome: 'refused', reason: 'agent_not_reachable' })
    await settle()
    expect(fake.acks.at(-1)).toEqual({
      deliveryId: 'd2',
      step: 'done',
      result: { outcome: 'refused', reason: 'agent_not_reachable' }
    })
    client.stop()
  })

  it('refuses stale and unreadable deliveries without the seam, and still runs the rest', async () => {
    const { client, calls } = startClient()
    await settle()
    poll([
      { ...base, deliveryId: 'old', kind: 'send', text: 'hi', expiresAt: SERVER_NOW + 9_000 },
      { ...base, deliveryId: 'new-kind', kind: 'rewind' },
      { kind: 'no-id' },
      {
        ...base,
        deliveryId: 'nowhere',
        kind: 'start',
        agent: 'claude',
        placeId: '???',
        prompt: 'x'
      },
      { ...base, deliveryId: 'gone', kind: 'answer', promptId: 'p1', optionId: 'allow_once' },
      { ...base, deliveryId: 'c1', kind: 'cancel' }
    ])
    await settle()
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
    expect(fake.acks).toEqual(
      expect.arrayContaining([
        { deliveryId: 'old', step: 'done', result: { outcome: 'expired' } },
        { deliveryId: 'new-kind', step: 'done', result: { outcome: 'unsupported' } },
        { deliveryId: 'nowhere', step: 'done', result: { outcome: 'unsupported' } },
        { deliveryId: 'gone', step: 'received' },
        {
          deliveryId: 'gone',
          step: 'done',
          result: { outcome: 'refused', reason: 'external_conversation_not_found' }
        },
        { deliveryId: 'c1', step: 'done', result: { outcome: 'accepted' } }
      ])
    )
    expect(fake.acks).not.toContainEqual({ deliveryId: 'old', step: 'received' })
    client.stop()
  })

  it('measures the deadline from when the poll was sent, so a slow answer only shortens it', async () => {
    const { client, calls } = startClient()
    await settle()
    // 15 s were left when the poll went out; the answer lands 6 s later, leaving 9 s.
    fake.pollReplyDelayMs = 6_000
    poll([
      { ...base, deliveryId: 'slow', kind: 'send', text: 'hi', expiresAt: SERVER_NOW + 15_000 }
    ])
    await settle(7_000)
    expect(calls.send).not.toHaveBeenCalled()
    expect(fake.acks).toContainEqual({
      deliveryId: 'slow',
      step: 'done',
      result: { outcome: 'expired' }
    })
    client.stop()
  })

  it('recovers deliveries an earlier process received from their receipts, never re-running them', async () => {
    const seam = fakeSeam()
    seam.recorded.set('d1', { outcome: 'accepted' })
    const { client, calls } = startClient(seam)
    await settle()
    poll([], {
      unsettled: [
        { deliveryId: 'd1', conversation },
        { deliveryId: 'd2', conversation }
      ]
    })
    await settle()
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } },
      { deliveryId: 'd2', step: 'done', result: { outcome: 'unknown', reason: 'no_local_record' } }
    ])
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
    client.stop()
  })

  it('answers a resend after a lost received without calling the seam twice', async () => {
    const seam = fakeSeam()
    seam.outcomes.set('d1', new Promise(() => {}))
    const { client, calls } = startClient(seam)
    await settle()
    const send = { ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }
    poll([send])
    await settle()
    poll([send], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(calls.send).toHaveBeenCalledTimes(1)
    expect(seam.calls.recorded).not.toHaveBeenCalled()
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd1', step: 'received' }
    ])
    client.stop()
  })

  it('says hello again, with a fresh snapshot, when the cloud asks after a new session', async () => {
    const { client } = startClient()
    await settle()
    fake.expireSessions()
    poll([])
    await settle()
    expect(fake.hellos).toHaveLength(2)
    expect(fake.events).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'snapshot', conversations: [] }
    ])
    client.stop()
  })

  it('keeps a turn end on disk until the cloud accepts it, across a restart', async () => {
    const outboxFile = join(userDataPath, 'connector-turn-outbox.json')
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const first = startClient()
    await settle()
    first.emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 100,
      stopReason: 'success',
      lastAssistantMessage: `x${'é'.repeat(5_000)}`,
      at: 300
    })
    first.emit({
      kind: 'turn-started',
      conversation: { source: 'dev', externalId: 'x' },
      worktreeId: 'wt',
      paneKey: 'tab:2',
      at: 5
    })
    await settle()
    const stored = JSON.parse(readFileSync(outboxFile, 'utf8'))
    expect(stored).toHaveLength(1)
    // 8 KB would split a two-byte character after the leading 'x', so the cut steps back one byte.
    expect(stored[0].lastAssistantMessage).toBe(`x${'é'.repeat(4_095)}`)
    first.client.stop()

    fake.forced.delete(CONNECTOR_PATHS.events)
    const second = startClient()
    await settle()
    expect(fake.events).toContainEqual(
      expect.objectContaining({ kind: 'turn-ended', turnId: 100, at: 300 })
    )
    expect(fake.events).not.toContainEqual(expect.objectContaining({ paneKey: 'tab:2' }))
    expect(existsSync(outboxFile)).toBe(false)
    second.client.stop()
  })

  it('stops and reports a revoked machine; a too-old client only stops', async () => {
    const revokedCase = startClient()
    await settle()
    fake.linked.clear()
    poll([])
    await settle()
    expect(revokedCase.onRevoked).toHaveBeenCalledTimes(1)

    fake.linked.set(identity.link.hostId, 'ada@example.com')
    const tooOld = startClient()
    await settle()
    poll([], { control: { stop: 'client_too_old' } })
    await settle()
    expect(tooOld.onRevoked).not.toHaveBeenCalled()
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
  })

  it('backs off through an outage and flushes confirmations once it is back', async () => {
    const { client } = startClient()
    await settle()
    fake.online = false
    poll([])
    await settle()
    const offlineAttempts = fake.requests.length
    await settle(3_000)
    expect(fake.requests.length).toBe(offlineAttempts)
    fake.online = true
    await settle(30_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(1)
    client.stop()
  })

  it('stops when connectors are turned off', async () => {
    const { client, disable } = startClient()
    await settle()
    disable()
    await settle()
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    poll([])
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
    client.stop()
  })
})
