import { randomBytes } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  openTestDatabase
} from './connector-server-harness.test-fixture.js'
import { LinearInstalls } from './linear-installs.js'
import type { LinearTokenGrant, LinearTokenResult } from './linear-oauth.js'
import { linearSchemaStatements } from './linear-schema.js'

afterEach(cleanupConnectorHarnesses)

const HOUR = 60 * 60_000
const ORG = 'org-1'

async function setup(answer: (grant: LinearTokenGrant) => Promise<LinearTokenResult>) {
  const { database } = await openTestDatabase()
  for (const statement of linearSchemaStatements()) {
    await database.query(statement)
  }
  let now = 1_800_000_000_000
  const grants: LinearTokenGrant[] = []
  const installs = new LinearInstalls(
    randomBytes(32),
    async (grant) => {
      grants.push(grant)
      return await answer(grant)
    },
    () => now
  )
  await installs.save(database, {
    organizationId: ORG,
    appUserId: 'app-user-1',
    tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: now + 24 * HOUR }
  })
  return {
    database,
    installs,
    grants,
    advance: (ms: number) => (now += ms),
    at: () => now
  }
}

const rotated = (n: number, expiresAt: number): LinearTokenResult => ({
  kind: 'ok',
  tokens: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt }
})

describe('LinearInstalls', () => {
  it('stores the install with its tokens sealed', async () => {
    const { database, installs } = await setup(async () => ({ kind: 'unknown' }))
    expect(await installs.find(database, ORG)).toEqual({
      organizationId: ORG,
      appUserId: 'app-user-1',
      paused: false
    })
    const [row] = await database.query(
      'SELECT access_token, refresh_token FROM connector_linear_installs'
    )
    expect(JSON.stringify(row)).not.toMatch(/access-1|refresh-1/)
    expect(await installs.setPaused(database, ORG, true)).toBe(true)
    expect((await installs.find(database, ORG))?.paused).toBe(true)
    expect(await installs.accessToken(database, 'org-2')).toEqual({ kind: 'missing' })
  })

  it('serves the stored token until an hour before expiry, then refreshes once', async () => {
    const env = await setup(async () => rotated(2, env.at() + 24 * HOUR))
    const { database, installs, grants, advance } = env
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-1' })
    advance(23 * HOUR)
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-2' })
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-2' })
    expect(grants).toEqual([{ grantType: 'refresh_token', refreshToken: 'refresh-1' }])
  })

  it('replays the same refresh token after an unknown answer', async () => {
    let answer: LinearTokenResult = { kind: 'unknown' }
    const { database, installs, grants, advance, at } = await setup(async () => answer)
    advance(23 * HOUR + 30 * 60_000)
    // Still half an hour left: keep serving the old token.
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-1' })
    advance(HOUR)
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'retry' })
    answer = rotated(2, at() + 24 * HOUR)
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-2' })
    expect(
      grants.map((grant) => grant.grantType === 'refresh_token' && grant.refreshToken)
    ).toEqual(['refresh-1', 'refresh-1', 'refresh-1'])
  })

  it('reports a refused refresh as missing once the token has expired', async () => {
    const { database, installs, advance } = await setup(async () => ({
      kind: 'failed',
      error: 'invalid_grant'
    }))
    advance(23 * HOUR + 30 * 60_000)
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'ok', token: 'access-1' })
    advance(HOUR)
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'missing' })
  })

  it('refreshes once when two callers find the token near expiry together', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const env = await setup(async () => {
      await held
      return rotated(2, env.at() + 24 * HOUR)
    })
    const { database, installs, grants, advance } = env
    advance(25 * HOUR)
    const first = installs.accessToken(database, ORG)
    const second = installs.accessToken(database, ORG)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const results = await Promise.all([first, second])
    expect(grants).toHaveLength(1)
    expect(results[0]).toEqual({ kind: 'ok', token: 'access-2' })
    // SQLite queues the second caller behind the first; Postgres skips the locked row.
    expect([
      { kind: 'ok', token: 'access-2' },
      { kind: 'retry', afterMs: 5_000 }
    ]).toContainEqual(results[1])
  })

  it('leaves a row another instance holds and serves the token while it is still valid', async () => {
    const env = await setup(async () => rotated(2, env.at() + 24 * HOUR))
    const { installs, grants, advance } = env
    // Postgres' SKIP LOCKED returns nothing for a row another transaction holds.
    const skipping: CloudDatabase = {
      ...env.database,
      query: (sql, params) => env.database.query(sql, params),
      transaction: (run) =>
        env.database.transaction((transaction) =>
          run({
            ...transaction,
            dialect: 'postgres',
            query: async (sql, params) =>
              /FOR UPDATE SKIP LOCKED/.test(sql) ? [] : await transaction.query(sql, params)
          })
        )
    }
    advance(23 * HOUR + 30 * 60_000)
    expect(await installs.accessToken(skipping, ORG)).toEqual({ kind: 'ok', token: 'access-1' })
    advance(HOUR)
    expect(await installs.accessToken(skipping, ORG)).toEqual({ kind: 'retry', afterMs: 5_000 })
    expect(grants).toEqual([])
  })

  it('treats a token sealed for another workspace or role as missing', async () => {
    const { database, installs } = await setup(async () => ({ kind: 'unknown' }))
    await database.query(
      'UPDATE connector_linear_installs SET access_token = refresh_token WHERE organization_id = ?',
      [ORG]
    )
    expect(await installs.accessToken(database, ORG)).toEqual({ kind: 'missing' })
  })
})
