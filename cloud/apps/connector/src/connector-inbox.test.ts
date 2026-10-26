import {
  CONNECTOR_LIMITS,
  ConnectorHostSessionResponseSchema,
  ConnectorPollResponseSchema
} from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { DeliveryBody } from './connector-inbox.js'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness,
  hiddenField,
  pauseBefore
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

const START: DeliveryBody = { kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
const SEND: DeliveryBody = { kind: 'send', text: 'and the tests' }

// Fails the first statement starting with `prefix` once armed, as a transient database fault.
function failOnce(database: CloudDatabase, prefix: string) {
  let armed = false
  const wrap = (inner: CloudDatabase): CloudDatabase => ({
    dialect: inner.dialect,
    query: async (sql, params) => {
      if (armed && sql.trimStart().startsWith(prefix)) {
        armed = false
        throw new Error('injected')
      }
      return await inner.query(sql, params)
    },
    transaction: (run) => inner.transaction((transaction) => run(wrap(transaction))),
    lockQuotaScope: (key) => inner.lockQuotaScope(key),
    tryLockScope: (key) => inner.tryLockScope(key),
    tryLockSharedScope: (key) => inner.tryLockSharedScope(key),
    close: () => inner.close()
  })
  return { database: wrap(database), arm: () => (armed = true) }
}

async function setup(options: Parameters<typeof createConnectorHarness>[1] = {}) {
  const harness = await createConnectorHarness({}, options)
  const machine = await harness.linkedMachine()
  expect((await machine.hello()).status).toBe(204)
  const enqueue = (externalId: string, deliveryId: string, body: DeliveryBody) =>
    harness.runtime.queueDelivery({
      thread: {
        externalId,
        teamId: 'T1',
        channelId: 'C1',
        threadTs: externalId,
        ownerUserId: 'U1',
        hostId: machine.hostId,
        placeId: 'pl_1'
      },
      deliveryId,
      body
    })
  const poll = async () => {
    const { status, body } = await machine.poll()
    expect(status).toBe(200)
    return ConnectorPollResponseSchema.parse(body)
  }
  const ids = async () => (await poll()).deliveries.map((delivery) => delivery.deliveryId)
  return { harness, machine, enqueue, poll, ids }
}

describe('connector inbox', () => {
  it('requires a hello for the revision a poll names', async () => {
    const harness = await createConnectorHarness()
    const machine = await harness.linkedMachine()
    expect((await machine.poll()).status).toBe(409)
    await machine.hello(1)
    expect((await machine.poll(2)).status).toBe(409)
    expect((await machine.poll(1)).status).toBe(200)
  })

  it('hands out a queued delivery with its envelope', async () => {
    const { harness, enqueue, poll } = await setup()
    await expect(enqueue('T1:C1:1.0:U1', 'd1', START)).resolves.toBe('queued')
    const reply = await poll()
    expect(reply.holdMs).toBe(0)
    expect(reply.serverNow).toBe(harness.now())
    expect(reply.deliveries).toEqual([
      {
        ...START,
        deliveryId: 'd1',
        seq: 1,
        expiresAt: harness.now() + CONNECTOR_LIMITS.deliveryTtlMs,
        conversation: { source: 'slack', externalId: 'T1:C1:1.0:U1' }
      }
    ])
    await expect(enqueue('T1:C1:1.0:U1', 'd1', START)).resolves.toBe('duplicate')
  })

  it('wakes a held poll as soon as a delivery is queued', async () => {
    const { enqueue, poll } = await setup({ pollHoldMs: 10_000 })
    const held = poll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedAt = Date.now()
    await enqueue('T1:C1:1.0:U1', 'd1', START)
    expect((await held).deliveries.map((delivery) => delivery.deliveryId)).toEqual(['d1'])
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('sends one delivery per conversation until it is received', async () => {
    const { machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('a', 'a2', SEND)
    await enqueue('b', 'b1', START)
    expect(await ids()).toEqual(['a1', 'b1'])
    expect(await ids()).toEqual([])
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    expect(await ids()).toEqual(['a2'])
  })

  it('resends a delivery with the same id once its lease runs out unreceived', async () => {
    const { harness, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    harness.advance(CONNECTOR_LIMITS.leaseMs - 1)
    expect(await ids()).toEqual([])
    harness.advance(1)
    expect(await ids()).toEqual(['a1'])
  })

  it('lists received-but-not-done deliveries on the first poll of a new session only', async () => {
    const { harness, machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('b', 'b1', START)
    await poll()
    await machine.ack([
      { deliveryId: 'a1', step: 'received' },
      { deliveryId: 'b1', step: 'received' },
      { deliveryId: 'b1', step: 'done', result: { outcome: 'accepted' } }
    ])
    expect((await poll()).unsettled).toBeUndefined()

    // The machine restarts: a new session, a new hello, then its first poll.
    const { sessionToken } = ConnectorHostSessionResponseSchema.parse(
      await (await harness.machineSession(machine.host)).json()
    )
    const auth = { authorization: `Bearer ${sessionToken}` }
    const first = await harness.json('/v1/connector/poll', { v: 1, helloRev: 1 }, auth)
    expect(ConnectorPollResponseSchema.parse(await first.json()).unsettled).toEqual([
      { deliveryId: 'a1', conversation: { source: 'slack', externalId: 'a' } }
    ])
    const second = await harness.json('/v1/connector/poll', { v: 1, helloRev: 1 }, auth)
    expect(ConnectorPollResponseSchema.parse(await second.json()).unsettled).toBeUndefined()
  })

  // SQLite runs one transaction at a time, so only Postgres can interleave the sweep with a claim.
  it.skipIf(!process.env.ORCA_CONNECTOR_TEST_DATABASE_URL)(
    'keeps an expiry that lands while a resend is being claimed',
    async () => {
      let gate!: ReturnType<typeof pauseBefore>
      const { harness, enqueue, poll } = await setup({
        wrapDatabase: (database) => {
          gate = pauseBefore(database, "UPDATE connector_inbox SET state = 'leased'", 1)
          return gate.database
        }
      })
      await enqueue('a', 'a1', START)
      await poll()
      harness.advance(CONNECTOR_LIMITS.leaseMs)
      const resend = poll()
      await gate.atStatement
      // The sweep takes no host lock, so it can expire the row between the claim's read and write.
      harness.advance(CONNECTOR_LIMITS.deliveryTtlMs)
      expect(await harness.runtime.inbox.expireDue()).toHaveLength(1)
      gate.release()
      expect((await resend).deliveries).toEqual([])
      const [row] = await harness.database.query(
        "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
      )
      expect(row?.state).toBe('expired')
    }
  )

  it('keeps recovery for the next poll when the first one fails', async () => {
    let fault!: ReturnType<typeof failOnce>
    const { harness, machine, enqueue, poll } = await setup({
      wrapDatabase: (database) => {
        fault = failOnce(database, 'SELECT delivery_id, external_id, seq')
        return fault.database
      }
    })
    await enqueue('a', 'a1', START)
    await poll()
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    const { sessionToken } = ConnectorHostSessionResponseSchema.parse(
      await (await harness.machineSession(machine.host)).json()
    )
    const auth = { authorization: `Bearer ${sessionToken}` }
    fault.arm()
    expect((await harness.json('/v1/connector/poll', { v: 1, helloRev: 1 }, auth)).status).toBe(500)
    const retry = await harness.json('/v1/connector/poll', { v: 1, helloRev: 1 }, auth)
    expect(ConnectorPollResponseSchema.parse(await retry.json()).unsettled).toEqual([
      { deliveryId: 'a1', conversation: { source: 'slack', externalId: 'a' } }
    ])
  })

  it('sends a poll held across a newer hello back to hello', async () => {
    const { machine } = await setup({ pollHoldMs: 10_000 })
    const held = machine.poll(1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedAt = Date.now()
    expect((await machine.hello(2)).status).toBe(204)
    expect((await held).status).toBe(409)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('refuses an ack from a session a newer one replaced', async () => {
    const { harness, machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await poll()
    expect((await harness.machineSession(machine.host)).status).toBe(200)
    expect((await machine.ack([{ deliveryId: 'a1', step: 'received' }])).status).toBe(401)
    const [row] = await harness.database.query(
      "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row?.state).toBe('leased')
  })

  it('keeps the first done', async () => {
    const { harness, machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await poll()
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'accepted' } }])
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'unsupported' } }])
    const [row] = await harness.database.query(
      "SELECT state, result, payload FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row).toEqual({ state: 'done', result: '{"outcome":"accepted"}', payload: null })
  })

  it('drops a start the machine never received when it is cancelled', async () => {
    const { enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('a', 'a2', SEND)
    await expect(enqueue('a', 'a3', { kind: 'cancel' })).resolves.toBe('dropped')
    expect(await ids()).toEqual([])
  })

  it('lets a cancel skip the queue once its start is received', async () => {
    const { machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    await enqueue('a', 'a2', SEND)
    expect(await ids()).toEqual(['a2'])
    await enqueue('a', 'a3', SEND)
    await expect(enqueue('a', 'a4', { kind: 'cancel' })).resolves.toBe('queued')
    expect(await ids()).toEqual(['a4'])
  })

  it('still lets a cancel skip the queue after its settled start is pruned', async () => {
    const { harness, machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await ids()
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'accepted' } }])
    // What retention leaves of a long conversation: its settled start is gone.
    await harness.database.query("DELETE FROM connector_inbox WHERE delivery_id = 'a1'")
    await enqueue('a', 'a2', SEND)
    expect(await ids()).toEqual(['a2'])
    await enqueue('a', 'a3', { kind: 'cancel' })
    expect(await ids()).toEqual(['a3'])
  })

  it('queues nothing for a revoked machine', async () => {
    const { machine, enqueue } = await setup()
    const page = await (await machine.owner.get('/machines')).text()
    await machine.owner.post(`/v1/account/hosts/${machine.hostId}/revoke`, {
      csrf: hiddenField(page, 'csrf')
    })
    await expect(enqueue('a', 'a1', START)).resolves.toBe('host_not_linked')
  })

  it('expires pending work at its deadline and leased work 30 s after it', async () => {
    const { harness, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    await enqueue('b', 'b1', START)
    harness.advance(CONNECTOR_LIMITS.deliveryTtlMs)
    expect(await harness.runtime.inbox.expireDue()).toEqual([
      { hostId: expect.any(String), externalId: 'b' }
    ])
    expect(await ids()).toEqual([])
    harness.advance(CONNECTOR_LIMITS.leasedExpiryGraceMs)
    expect(await harness.runtime.inbox.expireDue()).toEqual([
      { hostId: expect.any(String), externalId: 'a' }
    ])
  })

  it('accepts a late received for expired work', async () => {
    const { harness, machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await ids()
    harness.advance(CONNECTOR_LIMITS.deliveryTtlMs + CONNECTOR_LIMITS.leasedExpiryGraceMs)
    await harness.runtime.inbox.expireDue()
    expect((await machine.ack([{ deliveryId: 'a1', step: 'received' }])).status).toBe(204)
    const [row] = await harness.database.query(
      "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row?.state).toBe('received')
  })

  it('stops a held poll that a revoke lands on and expires its waiting work', async () => {
    const { harness, machine, enqueue, poll } = await setup({ pollHoldMs: 10_000 })
    await enqueue('a', 'a1', START)
    await poll()
    // Queued behind the leased a1, so the next poll is held.
    await enqueue('a', 'a2', SEND)
    const page = await (await machine.owner.get('/machines')).text()
    const held = machine.poll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await machine.owner.post(`/v1/account/hosts/${machine.hostId}/revoke`, {
      csrf: hiddenField(page, 'csrf')
    })
    expect((await held).status).toBe(401)
    const states = await harness.database.query(
      'SELECT delivery_id, state FROM connector_inbox ORDER BY seq'
    )
    expect(states).toEqual([
      { delivery_id: 'a1', state: 'expired' },
      { delivery_id: 'a2', state: 'expired' }
    ])
  })

  it('refuses a poll whose request was authorized just before a revoke committed', async () => {
    let gate!: ReturnType<typeof pauseBefore>
    const { machine, enqueue } = await setup({
      wrapDatabase: (database) => {
        gate = pauseBefore(database, 'UPDATE connector_hosts SET revoked_at')
        return gate.database
      }
    })
    await enqueue('a', 'a1', START)
    const page = await (await machine.owner.get('/machines')).text()
    const revoke = machine.owner.post(`/v1/account/hosts/${machine.hostId}/revoke`, {
      csrf: hiddenField(page, 'csrf')
    })
    await gate.atStatement
    // Holding the host lock, the revoke makes the poll's locked pass wait and then see it.
    const reply = machine.poll()
    await new Promise((resolve) => setTimeout(resolve, 200))
    gate.release()
    expect((await revoke).status).toBe(303)
    expect((await reply).status).toBe(401)
  })

  it('wakes a held poll when a lease runs out', async () => {
    const { harness, enqueue, ids, poll } = await setup({ pollHoldMs: 10_000 })
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    harness.advance(CONNECTOR_LIMITS.leaseMs - 100)
    const startedAt = Date.now()
    const held = poll()
    setTimeout(() => harness.advance(100), 50)
    expect((await held).deliveries.map((delivery) => delivery.deliveryId)).toEqual(['a1'])
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('answers held polls at once with a reconnect when the instance drains', async () => {
    const { harness, machine } = await setup({ pollHoldMs: 10_000 })
    const held = machine.poll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    harness.runtime.waker.drain()
    const reply = ConnectorPollResponseSchema.parse((await held).body)
    expect(reply.control).toEqual({ reconnect: true })
  })
})
