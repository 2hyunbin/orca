import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import { ConnectorCloud } from './connector-cloud'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam, type FakeSeam } from './fake-connector-seam.test-fixture'

let userDataPath: string
let outbox: string
let fake: FakeConnectorCloud
let enabled: boolean
let account: string | null
let seam: FakeSeam
let machine: ReturnType<typeof fakeMachine>

function connectorCloud(): ConnectorCloud {
  return new ConnectorCloud({
    userDataPath,
    origin: fake.origin,
    machine,
    account: () => account,
    mintFor: (who) => fake.mintFor(who),
    fetchImpl: fake.fetch
  })
}

const turnEnd = {
  kind: 'turn-ended',
  conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' },
  paneKey: 'tab:1',
  turnId: 1,
  at: 2,
  stopReason: null
}

beforeEach(() => {
  vi.useFakeTimers()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-cloud-'))
  outbox = join(userDataPath, 'connector-turn-outbox.json')
  fake = new FakeConnectorCloud()
  enabled = true
  account = 'ada'
  seam = fakeSeam()
  machine = fakeMachine(() => (enabled ? seam : null))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorCloud', () => {
  it('holds the poll only while signed in and on, and stops on disable and sign-out', async () => {
    account = null
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(0)

    account = 'ada'
    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)

    enabled = false
    seam.disable()
    machine.toggle()
    enabled = true
    seam = fakeSeam()
    machine.toggle()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)

    cloud.signingOut()
    fake.answerPoll({ status: 200, body: { v: 1, serverNow: 1, holdMs: 0, deliveries: [] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(2)
  })

  it('stays stopped from sign-out until the next sign-in, even if connectors are toggled meanwhile', async () => {
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    // The old account is still readable while the sign-out request runs.
    cloud.signingOut()
    machine.toggle()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)

    cloud.accountChanged()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(2)
  })

  it('keeps pending turn ends for the same account, and drops them on a switch or sign-out', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'ada', turnEnds: [turnEnd] }))
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const cloud = connectorCloud()
    cloud.connect()
    await vi.advanceTimersByTimeAsync(10)
    cloud.accountChanged()
    expect(existsSync(outbox)).toBe(true)

    fake.signedIn.add('grace')
    account = 'grace'
    cloud.accountChanged()
    expect(existsSync(outbox)).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.minted.at(-1)?.account).toBe('grace')

    writeFileSync(outbox, JSON.stringify({ account: 'grace', turnEnds: [turnEnd] }))
    const restarted = connectorCloud()
    restarted.signingOut()
    expect(existsSync(outbox)).toBe(false)
  })

  it('never sends turn ends another account left before a relaunch', async () => {
    writeFileSync(outbox, JSON.stringify({ account: 'grace', turnEnds: [turnEnd] }))
    connectorCloud().connect()
    await vi.advanceTimersByTimeAsync(10)
    expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
  })
})
