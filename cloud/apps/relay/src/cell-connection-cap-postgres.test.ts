import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSIGNMENT_CONNECTION_HEADROOM_QUERY } from './assignment-connection-headroom-query.js'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const CELL_ID = 'connection-cap-min-postgres'
const configured = (connectionHardCap: 1_000 | 3_000): RelayCellConfig => ({
  id: CELL_ID,
  url: 'https://connection-cap-min-postgres.example.com',
  capacityRequests: 1_000,
  connectionHardCap,
  connectionUnobservedBound: 60
})

async function removeCell(database: RelayDatabase): Promise<void> {
  for (const table of [
    'relay_cell_connection_snapshots',
    'relay_cell_connection_runtime',
    'relay_cell_connection_limits',
    'relay_cell_capabilities',
    'relay_cell_rehome_safety',
    'relay_cell_runtime',
    'relay_cell_admission',
    'relay_cell_regions',
    'relay_cells'
  ]) {
    await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [CELL_ID])
  }
}

describePostgres('PostgreSQL effective connection cap', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    await removeCell(database)
  })

  afterAll(async () => {
    await removeCell(database)
    await database.close()
  })

  it('records the previous cap on a raise and places against the cell-reported cap', async () => {
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const heartbeat = async (connectionHardCap: number, units: number): Promise<void> =>
      await store.recordCellHeartbeat({
        cellId: CELL_ID,
        cellUrl: configured(1_000).url,
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        startedAt: 50,
        ready: true,
        observedRequests: 0,
        totalConnections: units,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: units,
        connectionHardCap,
        connectionUnobservedBound: 60
      })
    await store.reconcileCells([configured(1_000)], true)
    await heartbeat(1_000, 10)
    // A pre-change director's row: no report stamped.
    await database.query(
      `UPDATE relay_cell_connection_limits SET reported_hard_cap = NULL WHERE cell_id = ?`,
      [CELL_ID]
    )

    await store.reconcileCells([configured(3_000)], true)
    const status = await store.cellDeploymentStatus(CELL_ID)
    expect(status.connectionCapacity).toMatchObject({
      hardCap: 3_000,
      reportedHardCap: 1_000,
      effectiveHardCap: 1_000,
      normalAdmissionPause: 840,
      heartbeatFresh: true
    })

    await heartbeat(1_000, 839)
    const headroom = await database.query(
      `${ASSIGNMENT_CONNECTION_HEADROOM_QUERY} WHERE limits.cell_id = ?`,
      [CELL_ID]
    )
    expect(Number(headroom[0]?.effective_hard_cap)).toBe(1_000)
    await expect(heartbeat(3_000, 0)).resolves.toBeUndefined()
    await expect(store.cellDeploymentStatus(CELL_ID)).resolves.toMatchObject({
      connectionCapacity: { reportedHardCap: 3_000, effectiveHardCap: 3_000 }
    })
  })
})
