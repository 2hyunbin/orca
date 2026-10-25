import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { DEAD_MAN_SLOT_CLAIM_RETRY_MS } from './cell-admit-effective-writer.js'
import { reserveDeadManWindowMs } from './cell-reserve-dead-man.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'

// A director outage with deadManTripSlots set: at most that many reserve cells trip to their full
// database pools. A cell left without a slot stays in reserve, serving its hosts from memory.

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const ticks = (count: number) => new Promise((resolve) => setTimeout(resolve, count * 1_100))

// Another reserve cell whose dead-man already tripped: it holds a slot while it heartbeats.
async function trippedPeer(database: RelayDatabase, cellId: string, at: number): Promise<(at: number) => Promise<void>> {
  await database.query(`INSERT INTO relay_cell_admit_modes (cell_id, admit_mode, updated_at) VALUES (?, 'reserve', ?)`, [cellId, at])
  await database.query(
    `INSERT INTO relay_cell_runtime
     (cell_id, cell_url, cell_incarnation, started_at, ready, observed_requests, last_heartbeat_at, updated_at)
     VALUES (?, ?, 'peer-incarnation', ?, 1, 0, ?, ?)`,
    [cellId, `https://${cellId}.example.com`, at, at, at]
  )
  await database.query(
    `INSERT INTO relay_cell_admit_effective (cell_id, cell_incarnation, mode, updated_at)
     VALUES (?, 'peer-incarnation', 'db', ?)`,
    [cellId, at]
  )
  return async (heartbeatAt) => {
    await database.query(`UPDATE relay_cell_runtime SET last_heartbeat_at = ? WHERE cell_id = ?`, [heartbeatAt, cellId])
  }
}

describe('dead-man trip slots', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function cell(now: () => number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-dead-man-slots-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const database = await openRelayDatabase({ dataDir })
    cleanup.push(() => database.close())
    return { database, reserve: await startReserveModeCell({ database, dataDir, cleanup, now }) }
  }

  const logged = (event: string) =>
    vi
      .mocked(console.error)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes(event))

  it('holds a silent cell in reserve while every slot is taken, then trips once one frees', async () => {
    let now = Date.now()
    const { database, reserve } = await cell(() => now)
    reserve.setAdmitMode('reserve', { deadManTripSlots: 1 })
    const heartbeat = await trippedPeer(database, 'production-gce-c90', now)
    const seated = await reserve.bookedHost(3)
    const returning = await reserve.bookedHost(4, { row: 'never' })
    await until(async () => (await reserve.admitEffectiveRow())?.mode === 'reserve')

    // The director goes away. Past this cell's window, c90 still holds the only slot.
    now += reserveDeadManWindowMs(reserve.config.cellId) + 1_000
    await heartbeat(now)
    await ticks(2)
    expect(reserve.relay.sessions.inReserveMode()).toBe(true)
    expect(logged('orca_relay_cell_reserve_dead_man_held')).toHaveLength(1)
    expect(logged('orca_relay_cell_reserve_dead_man_tripped')).toEqual([])
    // Not flipped: no re-registration, and its row keeps the database path off it.
    expect(await reserve.controlLeases()).toEqual([])
    expect((await reserve.admitEffectiveRow())?.mode).toBe('reserve')
    // Its hosts keep their sockets, and a host that drops and redials is let back in from memory.
    expect(seated.socket.readyState).toBe(WebSocket.OPEN)
    returning.socket.close()
    await returning.closeCode
    const back = await reserve.connect(returning.identity, 4)
    expect(back.ack.type).toBe('host-hello-ack')

    // c90 stops heartbeating: its slot frees, and this cell takes it on its next claim.
    now += Math.max(DEAD_MAN_SLOT_CLAIM_RETRY_MS, 60_000)
    await until(() => !reserve.relay.sessions.inReserveMode())
    expect(logged('orca_relay_cell_reserve_dead_man_tripped')).toHaveLength(1)
    expect((await reserve.admitEffectiveRow())?.mode).toBe('db')
    await until(async () => (await reserve.controlLeases()).length === 1)
    expect(seated.socket.readyState).toBe(WebSocket.OPEN)
  }, 30_000)

  it('with no slots, a cell rides out a long director outage in reserve and never trips', async () => {
    let now = Date.now()
    const { reserve } = await cell(() => now)
    reserve.setAdmitMode('reserve', { deadManTripSlots: 0 })
    const seated = await reserve.bookedHost(3)
    for (let minute = 0; minute < 30; minute += 5) {
      now += 5 * 60_000
      await ticks(1)
    }
    expect(reserve.relay.sessions.inReserveMode()).toBe(true)
    expect(logged('orca_relay_cell_reserve_dead_man_tripped')).toEqual([])
    expect(await reserve.controlLeases()).toEqual([])
    expect(seated.socket.readyState).toBe(WebSocket.OPEN)
  }, 30_000)

  it('without the flag, trips with every slot taken, as before', async () => {
    let now = Date.now()
    const { database, reserve } = await cell(() => now)
    await trippedPeer(database, 'production-gce-c90', now)
    await reserve.bookedHost(3)
    now += reserveDeadManWindowMs(reserve.config.cellId) + 1_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
  }, 30_000)
})
