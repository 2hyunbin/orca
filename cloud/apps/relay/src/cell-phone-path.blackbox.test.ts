import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reserveDeadManWindowMs } from './cell-reserve-dead-man.js'
import { openRelayDatabase } from './database.js'
import { nextFrame, startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'
import { StatementRecordingDatabase } from './test-fixtures/statement-recording-database.js'

// Step 6: a reserve-mode cell with phonePath=memory resumes paired phones without the database.

// Phone credentials are 32 random bytes.
const token = (fill: number) => Buffer.alloc(32, fill).toString('base64url')
const TOKEN = token(1)
const OTHER_CELL = { id: 'production-gce-c4', url: 'https://c4.relay.onorca.dev', capacityRequests: 900 }

// A paired phone's accept and attach with the switch off, as main issued them at 9ea54343710.
const DATABASE_PATH_ACCEPT = [
  'SELECT * FROM relay_devices WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)',
  'SELECT assignment.*, cell.cell_url, region.region FROM relay_assignments assignment JOIN relay_cells cell ON cell.cell_id = assignment.cell_id LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id WHERE assignment.user_id = ? AND assignment.relay_host_id = ?',
  'BEGIN',
  'SELECT * FROM relay_invites WHERE relay_host_id = ? AND token_hash = ?',
  'SELECT * FROM relay_devices WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)',
  'COMMIT',
  'BEGIN',
  'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ? [locked]',
  'SELECT * FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC [locked]',
  'UPDATE relay_assignments SET pending_confirmations = CASE WHEN pending_confirmations + ? < 0 THEN 0 ELSE pending_confirmations + ? END, lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END, last_activity_at = ? WHERE user_id = ? AND relay_host_id = ?',
  'INSERT INTO relay_assignment_activity_leases (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'UPDATE relay_cells SET reserved_requests = CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END, updated_at = ? WHERE cell_id = ? AND (? <= 0 OR reserved_requests + ? <= capacity_requests) RETURNING cell_id',
  'COMMIT',
  'BEGIN',
  'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ? [locked]',
  'SELECT * FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC [locked]',
  'UPDATE relay_assignments SET reserved_splices = CASE WHEN reserved_splices + ? < 0 THEN 0 ELSE reserved_splices + ? END, lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END, last_activity_at = ? WHERE user_id = ? AND relay_host_id = ?',
  'INSERT INTO relay_assignment_activity_leases (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'UPDATE relay_cells SET reserved_requests = CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END, updated_at = ? WHERE cell_id = ? AND (? <= 0 OR reserved_requests + ? <= capacity_requests) RETURNING cell_id',
  'COMMIT',
  'INSERT INTO relay_connection_bases (basis_conn_id, user_id, relay_host_id, relay_device_id, owning_control_generation, credential_kind, invite_token_hash, accepted_credential_version, accepted_as, deadline, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
]

describe('the memory phone path', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function cell(now?: () => number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-phone-path-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const inner = await openRelayDatabase({ dataDir })
    cleanup.push(() => inner.close())
    const database = new StatementRecordingDatabase(inner)
    const reserve = await startReserveModeCell({ database, dataDir, cleanup, ...(now ? { now } : {}) })
    // The admit-effective writer ticks on its own; every other statement is the phone's.
    const phoneStatements = () =>
      database.statements.filter((sql) => !sql.includes('relay_cell_admit_effective'))
    return { ...reserve, database, phoneStatements }
  }

  async function seatedPhoneHost(phonePath: 'db' | 'memory') {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, TOKEN)
    reserve.database.statements.length = 0
    return { reserve, seated }
  }

  const warnings = (event: string) =>
    vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes(event))
      .map((line) => JSON.parse(line))

  it('acts only while the cell is in reserve mode, so admitMode=db or a dead-man trip turns it off', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    reserve.setAdmitMode('db', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    now += reserveDeadManWindowMs(reserve.config.cellId) + 1_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
  })

  it('admits a seated phone resume from one device read and writes no activity lease', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    expect(await connOpen).toMatchObject({ kind: 'resume', relayDeviceId: 'device-1' })
    expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0]])
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ type: 'relay-hello', ok: true, credentialKind: 'resume' })
    expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0], DATABASE_PATH_ACCEPT.at(-1)])
    expect(await reserve.activityLeases()).toEqual([])
  })

  it('keeps the database path statement for statement while phonePath is db', async () => {
    const { reserve, seated } = await seatedPhoneHost('db')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ type: 'relay-hello', ok: true })
    expect(reserve.phoneStatements()).toEqual(DATABASE_PATH_ACCEPT)
  })

  it('closes a revoked or expired device 4401 and never tries it as an invite', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, token(2), { revokedAt: Date.now() - 1_000 })
    await reserve.installDevice(seated.identity.hostId, token(3), {
      relayDeviceId: 'device-2',
      expiresAt: Date.now() - 1_000
    })
    for (const refused of [token(2), token(3)]) {
      reserve.database.statements.length = 0
      const phone = await reserve.dialPhone(seated.identity.hostId, refused)
      expect(await phone.hello).toEqual({ type: 'relay-hello', ok: false, code: 4401 })
      expect((await phone.closed).code).toBe(4401)
      expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0]])
    }
  })

  it('closes 4503 when the device read fails, without trying the invite path', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    vi.spyOn(reserve.relay.store, 'lookupResume').mockRejectedValue(new Error('connection terminated'))
    const invite = vi.spyOn(reserve.relay.store, 'resolveInviteForMove')
    for (let dial = 0; dial < 2; dial += 1) {
      const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
      expect((await phone.closed).code).toBe(4503)
    }
    expect(invite).not.toHaveBeenCalled()
    expect(reserve.phoneStatements()).toEqual([])
    // One line opens the window; the repeat waits for its closing line.
    expect(warnings('orca_relay_client_accept_db_error')).toEqual([
      { event: 'orca_relay_client_accept_db_error', cause: 'error', cellId: reserve.config.cellId }
    ])
  })

  it('falls through to the invite path only when no device row matches', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const created = nextFrame(seated.socket, 'invite-created')
    seated.socket.send(JSON.stringify({ type: 'invite-create', reqId: 'invite-1', relayDeviceId: 'device-9' }))
    const invite = await created
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, String(invite.inviteToken))
    expect(await connOpen).toMatchObject({ kind: 'invite', relayDeviceId: 'device-9' })
    // Invites keep today's leases: install validates their basis in Postgres.
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual(['invite', 'invite'])
  })

  it('answers a phone whose host has no seat here from one assignment read', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    await reserve.relay.assignments.reconcileCells([...reserve.config.cells, OTHER_CELL])
    const dial = async (row: 'elsewhere' | 'here' | 'none') => {
      const host = await reserve.host()
      if (row !== 'none') await reserve.insertRow(host.hostId, 3, row === 'here' ? reserve.config.cellId : OTHER_CELL.id)
      await reserve.installDevice(host.hostId, TOKEN)
      reserve.database.statements.length = 0
      const phone = await reserve.dialPhone(host.hostId, TOKEN)
      const closed = await phone.closed
      expect(reserve.phoneStatements()).toEqual(DATABASE_PATH_ACCEPT.slice(0, 2))
      return closed.code
    }
    expect(await dial('elsewhere')).toBe(4409)
    expect(await dial('none')).toBe(4404)
    expect(warnings('orca_relay_client_miss_row_names_here')).toEqual([])
    expect(await dial('here')).toBe(4404)
    expect(warnings('orca_relay_client_miss_row_names_here')).toEqual([
      expect.objectContaining({ cellId: reserve.config.cellId, relayHostIdDigest: expect.any(String) })
    ])
    vi.spyOn(reserve.relay.assignments, 'resolve').mockRejectedValueOnce(new Error('connection terminated'))
    const host = await reserve.host()
    await reserve.installDevice(host.hostId, TOKEN)
    expect((await (await reserve.dialPhone(host.hostId, TOKEN)).closed).code).toBe(4409)
    expect(warnings('orca_relay_client_miss_read_error')).toEqual([
      { event: 'orca_relay_client_miss_read_error', cause: 'error', cellId: reserve.config.cellId }
    ])
  })

  it('takes the database path for a phone whose switch turned off during its device read', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const lookup = reserve.relay.store.lookupResume.bind(reserve.relay.store)
    vi.spyOn(reserve.relay.store, 'lookupResume').mockImplementation(async (...args) => {
      const found = await lookup(...args)
      reserve.setAdmitMode('reserve', { phonePath: 'db' })
      return found
    })
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, TOKEN)
    expect(await connOpen).toMatchObject({ kind: 'resume' })
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual(['confirmation'])
  })
})
