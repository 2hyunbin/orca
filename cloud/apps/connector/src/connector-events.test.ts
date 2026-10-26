import { CONNECTOR_PATHS, ConnectorPollResponseSchema } from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

const conversation = { source: 'slack', externalId: 'T1:C1:1.0:U1' }

// A loopback origin turns on the dev enqueue route, which also creates the thread.
async function setup() {
  const harness = await createConnectorHarness({ publicUrl: 'http://127.0.0.1:8080' })
  const machine = await harness.linkedMachine()
  await machine.hello()
  const enqueue = (hostId: string) =>
    harness.json('/dev/enqueue', {
      hostId,
      externalId: conversation.externalId,
      delivery: { kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
    })
  const events = (list: unknown[]) => machine.call(CONNECTOR_PATHS.events, { v: 1, events: list })
  const thread = async () =>
    (
      await harness.database.query(
        `SELECT pane_key, agent, open_turn_id, turn_state, turn_stop_reason, turn_last_message,
           pending_prompt FROM connector_threads`
      )
    )[0]
  return { harness, machine, enqueue, events, thread }
}

describe('connector turn events', () => {
  it('queues through the dev route only on a loopback origin', async () => {
    const remote = await createConnectorHarness()
    expect((await remote.json('/dev/enqueue', {})).status).toBe(404)
    const { machine, enqueue } = await setup()
    const queued = await enqueue(machine.hostId)
    expect(await queued.json()).toMatchObject({ status: 'queued' })
    const reply = ConnectorPollResponseSchema.parse((await machine.poll()).body)
    expect(reply.deliveries[0]).toMatchObject({ kind: 'start', conversation })
  })

  it('applies turn events once, whatever order and repeats they arrive in', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const linked = { conversation, paneKey: 'pane-1', kind: 'linked', agent: 'claude' }
    const started = { conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }
    const ended = {
      conversation,
      paneKey: 'pane-1',
      kind: 'turn-ended',
      turnId: 100,
      at: 160,
      stopReason: 'end_turn',
      lastAssistantMessage: 'done'
    }
    expect((await events([linked, started, ended])).status).toBe(204)
    const settled = {
      pane_key: 'pane-1',
      agent: 'claude',
      open_turn_id: 100,
      turn_state: 'ended',
      turn_stop_reason: 'end_turn',
      turn_last_message: 'done',
      pending_prompt: null
    }
    const row = await thread()
    // Postgres returns BIGINT as text.
    expect({ ...row, open_turn_id: Number(row?.open_turn_id) }).toEqual(settled)
    // A resent start for the same turn changes nothing.
    await events([started, ended, started])
    expect(await thread()).toMatchObject({ turn_state: 'ended', turn_last_message: 'done' })
  })

  it('reads an open turn the snapshot no longer shows as unverifiable, never as done', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    await events([
      {
        kind: 'snapshot',
        conversations: [{ conversation, paneKey: 'pane-1', agent: 'claude', working: false, prompt }]
      }
    ])
    expect(await thread()).toMatchObject({
      turn_state: 'unverifiable',
      pending_prompt: JSON.stringify(prompt)
    })
  })

  it('reads an open turn missing from the snapshot as unverifiable', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    await events([{ kind: 'snapshot', conversations: [] }])
    expect(await thread()).toMatchObject({ turn_state: 'unverifiable' })
  })

  it("ignores events for another host's thread", async () => {
    const { harness, machine, enqueue, thread } = await setup()
    await enqueue(machine.hostId)
    const other = await harness.linkedMachine(machine.owner)
    await other.call(CONNECTOR_PATHS.events, {
      v: 1,
      events: [{ conversation, paneKey: 'pane-9', kind: 'turn-started', at: 100 }]
    })
    expect(await thread()).toMatchObject({ pane_key: null, turn_state: null })
  })
})
