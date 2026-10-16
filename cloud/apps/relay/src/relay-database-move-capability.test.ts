import { describe, expect, it } from 'vitest'
import {
  markRelayDatabaseMoveCapability,
  readRelayDatabasePoolOldestWaitMs,
  readRelayDatabasePoolPressure,
  type RelayDatabase
} from './database.js'
import { scriptedPostgresDatabase, ScriptedPoolClient } from './test-fixtures/scripted-postgres-pool.js'

describe('relay database move capability', () => {
  it('keeps the mark inside the 63 bytes PostgreSQL stores', () => {
    expect(markRelayDatabaseMoveCapability('orca-relay/cell/production-gce-c17')).toBe(
      'orca-relay/cell/production-gce-c17 mv1'
    )
    const long = markRelayDatabaseMoveCapability(`orca-relay/director/${'x'.repeat(80)}`)
    expect(Buffer.byteLength(long)).toBe(63)
    expect(long.endsWith(' mv1')).toBe(true)
  })

  it('reads pool pressure from the pool a routing database serves from', () => {
    const serving = scriptedPostgresDatabase([new ScriptedPoolClient(), new ScriptedPoolClient()])
    const router: RelayDatabase = {
      query: async () => [],
      queryLocked: async () => [],
      transaction: async (operation) => await operation(router),
      activeRelayDatabase: () => serving,
      close: async () => undefined
    }
    expect(readRelayDatabasePoolPressure(router)).toMatchObject({ databasePoolTotal: 2 })
    expect(readRelayDatabasePoolOldestWaitMs(router)).toBe(0)
  })
})
