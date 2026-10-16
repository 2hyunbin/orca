import { describe, expect, it } from 'vitest'
import { parseDatabaseTargetPointer } from './relay-database-target-pointer.js'

const dedicated = {
  instanceConnectionName: 'onorca-cloud:us-central1:relay-db',
  databaseUrlSecret: 'projects/onorca-cloud/secrets/relay-db-url/versions/latest'
}

describe('database target pointer', () => {
  it('reads the dedicated target and an optional quiesce window', () => {
    expect(parseDatabaseTargetPointer({ version: 1, dedicated })).toEqual({
      flags: { version: 1, dedicated },
      ignoredKeys: []
    })
    const quiesce = { id: 'cut', startsAt: 1_760_000_000_000, until: 1_760_000_020_000 }
    expect(parseDatabaseTargetPointer({ version: 1, dedicated, quiesce })?.flags?.quiesce).toEqual(
      quiesce
    )
  })

  it('voids an object it cannot follow safely', () => {
    const startsAt = 1_760_000_000_000
    for (const body of [
      null,
      { version: 2, dedicated },
      { version: 1 },
      { version: 1, dedicated: { ...dedicated, databaseUrlSecret: 'postgresql://u:p@/db' } },
      // Longer than the 20 s cap, or ending before it starts.
      { version: 1, dedicated, quiesce: { id: 'cut', startsAt, until: startsAt + 20_001 } },
      { version: 1, dedicated, quiesce: { id: 'cut', startsAt, until: startsAt } }
    ]) {
      expect(parseDatabaseTargetPointer(body)).toBeNull()
    }
  })
})
