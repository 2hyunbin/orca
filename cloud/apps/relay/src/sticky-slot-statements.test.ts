import { describe, expect, it } from 'vitest'
import { PostgresDatabase, type RelayDatabase } from './database.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import { connectionTaggedDatabase } from './test-fixtures/connection-tagged-database.js'
import { RelayObservability } from './relay-observability.js'
import { runInStickySlot, StickySlotStatements } from './sticky-slot-statements.js'

function observed(connectionIds: number[]): RelayDatabase {
  return observeRelayDatabase(
    connectionTaggedDatabase(connectionIds),
    new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      () => undefined
    )
  )
}

describe('sticky slot statements', () => {
  it('charges a slot its own statements, grouping transaction ones by connection', async () => {
    const database = observed([7, 7, 9])
    const slot = new StickySlotStatements()
    await runInStickySlot(slot, async () => {
      await database.query('SELECT 1')
      await database.transaction(async (transaction) => {
        await transaction.query('SELECT 2')
        await transaction.queryLocked('SELECT 3')
      })
      await database.transaction(async (transaction) => await transaction.query('SELECT 4'))
    })
    // Outside the slot: not this request's work.
    await database.transaction(async (transaction) => await transaction.query('SELECT 5'))

    const sample = slot.close()
    expect(sample.statements).toBe(4)
    expect(sample.sqlMs).toBeGreaterThanOrEqual(0)
    expect([...sample.statementMsByConnection.keys()]).toEqual([7])
    expect(sample.statementMsByConnection.get(7)).toHaveLength(3)
  })

  it('keeps concurrent requests apart', async () => {
    const database = observed([1, 2])
    const sticky = new StickySlotStatements()
    let releaseOther!: () => void
    const otherHolds = new Promise<void>((resolve) => (releaseOther = resolve))
    // Another lane's transaction is in flight across the whole sticky request.
    const other = database.transaction(async (transaction) => {
      await otherHolds
      await transaction.query('SELECT other')
    })
    await runInStickySlot(sticky, async () => {
      await database.transaction(async (transaction) => await transaction.query('SELECT mine'))
    })
    releaseOther()
    await other

    const sample = sticky.close()
    expect(sample.statements).toBe(1)
    expect([...sample.statementMsByConnection.keys()]).toEqual([2])
  })

  it('ignores work the request left running after it released the slot', async () => {
    const database = observed([])
    const slot = new StickySlotStatements()
    let finishLate!: () => void
    const late = new Promise<void>((resolve) => (finishLate = resolve))
    let leftRunning: Promise<unknown> | undefined
    await runInStickySlot(slot, async () => {
      await database.query('SELECT 1')
      leftRunning = late.then(async () => await database.query('SELECT late'))
    })
    const sample = slot.close()
    finishLate()
    await leftRunning
    expect(sample.statements).toBe(1)
  })
})

describe('PostgreSQL transaction connection ids', () => {
  it('names each pooled connection once, however often it is checked out', async () => {
    const first = fakeClient()
    const second = fakeClient()
    const checkouts = [first, second, first]
    const database = new PostgresDatabase({
      totalCount: 2,
      idleCount: 0,
      waitingCount: 0,
      connect: async () => checkouts.shift()
    } as never)
    const ids: Array<number | undefined> = []
    for (let index = 0; index < 3; index++) {
      await database.transaction(async (transaction) => {
        ids.push(transaction.connectionId)
      })
    }
    expect(ids).toEqual([1, 2, 1])
  })
})

function fakeClient() {
  return {
    on: () => undefined,
    off: () => undefined,
    removeListener: () => undefined,
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined
  }
}
