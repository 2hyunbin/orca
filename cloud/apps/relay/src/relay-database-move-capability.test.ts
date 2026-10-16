import { describe, expect, it } from 'vitest'
import {
  markRelayDatabaseMoveCapability,
  readRelayDatabasePoolOldestWaitMs,
  readRelayDatabasePoolPressure,
  type RelayDatabase
} from './database.js'
import { scriptedPostgresDatabase, ScriptedPoolClient } from './test-fixtures/scripted-postgres-pool.js'

describe('relay database move capability', () => {
  it('marks each process with its own id, inside the 63 bytes PostgreSQL stores', () => {
    expect(markRelayDatabaseMoveCapability('orca-relay/cell/production-gce-c17', '0a1b2c3d')).toBe(
      'orca-relay/cell/production-gce-c17 mv1:0a1b2c3d'
    )
    const long = markRelayDatabaseMoveCapability(`orca-relay/director/${'x'.repeat(80)}`, 'deadbeef')
    expect(Buffer.byteLength(long)).toBe(63)
    expect(long.endsWith(' mv1:deadbeef')).toBe(true)
    expect(() => markRelayDatabaseMoveCapability('orca-relay', 'not-hex!')).toThrow()
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
