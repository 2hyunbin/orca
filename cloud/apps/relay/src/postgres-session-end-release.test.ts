import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseNothingRanError, PostgresDatabase } from './database.js'

// One client whose statements fail as given; records what each checkout released it with.
function failingPool(failure: () => Error) {
  const releases: unknown[] = []
  const client = Object.assign(new EventEmitter(), {
    query: async () => {
      throw failure()
    },
    release: (error?: unknown) => void releases.push(error)
  })
  const pool = { totalCount: 1, idleCount: 0, waitingCount: 0, connect: async () => client }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  return { database: new PostgresDatabase(pool as never), releases }
}

describe('PostgreSQL session end', () => {
  it('destroys a client whose session the server ended, so no caller inherits it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const terminated = () => Object.assign(new Error('terminating connection'), { code: '57P01' })
    const query = failingPool(terminated)
    await expect(query.database.query('SELECT 1')).rejects.toMatchObject({ code: '57P01' })
    expect(query.releases).toEqual([expect.objectContaining({ code: '57P01' })])

    const transaction = failingPool(terminated)
    await expect(transaction.database.transaction(async () => undefined)).rejects.toMatchObject({
      code: '57P01'
    })
    expect(transaction.releases).toEqual([expect.objectContaining({ code: '57P01' })])
    vi.restoreAllMocks()
  })

  it('counts a failed BEGIN or a dead client at checkout as nothing ran, and nothing else', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const begin = failingPool(() => Object.assign(new Error('terminating'), { code: '57P01' }))
    const atBegin = await begin.database.transaction(async () => undefined).catch((e: unknown) => e)
    expect(isRelayDatabaseNothingRanError(atBegin)).toBe(true)
    const dead = failingPool(() => new Error('Client was closed and is not queryable'))
    const atCheckout = await dead.database.query('SELECT 1').catch((e: unknown) => e)
    expect(isRelayDatabaseNothingRanError(atCheckout)).toBe(true)
    const ran = failingPool(() => Object.assign(new Error('terminating'), { code: '57P01' }))
    const midStatement = await ran.database.query('SELECT 1').catch((e: unknown) => e)
    expect(isRelayDatabaseNothingRanError(midStatement)).toBe(false)
    vi.restoreAllMocks()
  })
})
