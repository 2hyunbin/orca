import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupConnectorHarnesses,
  openTestDatabase
} from './connector-server-harness.test-fixture.js'
import type { LinearTokenGrant, LinearTokenResult, LinearTokens } from './linear-oauth.js'
import { linearAccessToken, type LinearCredentialStore } from './linear-token-refresh.js'

afterEach(cleanupConnectorHarnesses)

const HOUR = 60 * 60_000
const ORG = 'org-1'

// Stands in for the installs table: one JSON credentials column per workspace.
const store: LinearCredentialStore = {
  read: async (database, organizationId) => {
    const [row] = await database.query(
      'SELECT credentials FROM linear_test_installs WHERE organization_id = ?',
      [organizationId]
    )
    return row ? JSON.parse(String(row.credentials)) : null
  },
  write: async (database, organizationId, tokens) => {
    await database.query(
      'UPDATE linear_test_installs SET credentials = ? WHERE organization_id = ?',
      [JSON.stringify(tokens), organizationId]
    )
  },
  remove: async (database, organizationId) => {
    await database.query('DELETE FROM linear_test_installs WHERE organization_id = ?', [
      organizationId
    ])
  }
}

async function setup(answer: (grant: LinearTokenGrant) => Promise<LinearTokenResult>) {
  const { database } = await openTestDatabase()
  await database.query(
    'CREATE TABLE linear_test_installs (organization_id TEXT PRIMARY KEY, credentials TEXT NOT NULL)'
  )
  let now = 1_800_000_000_000
  const tokens: LinearTokens = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: now + 24 * HOUR
  }
  await database.query('INSERT INTO linear_test_installs VALUES (?, ?)', [
    ORG,
    JSON.stringify(tokens)
  ])
  const grants: LinearTokenGrant[] = []
  const access = (db: CloudDatabase = database, organizationId = ORG) =>
    linearAccessToken(
      {
        database: db,
        store,
        tokenEndpoint: async (grant) => {
          grants.push(grant)
          return await answer(grant)
        },
        now: () => now
      },
      organizationId
    )
  return { database, access, grants, advance: (ms: number) => (now += ms), at: () => now }
}

const rotated = (n: number, expiresAt: number): LinearTokenResult => ({
  kind: 'ok',
  tokens: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt }
})
const refreshTokens = (grants: LinearTokenGrant[]) =>
  grants.map((grant) => (grant.grantType === 'refresh_token' ? grant.refreshToken : null))

describe('linearAccessToken', () => {
  it('is missing without an install', async () => {
    const { access } = await setup(async () => ({ kind: 'unknown' }))
    expect(await access(undefined, 'org-2')).toEqual({ kind: 'missing' })
  })

  it('serves the stored token until five minutes before expiry, then refreshes once', async () => {
    const env = await setup(async () => rotated(2, env.at() + 24 * HOUR))
    const { access, grants, advance } = env
    advance(24 * HOUR - 5 * 60_000 - 1)
    expect(await access()).toEqual({ kind: 'ok', token: 'access-1' })
    advance(1)
    expect(await access()).toEqual({ kind: 'ok', token: 'access-2' })
    expect(await access()).toEqual({ kind: 'ok', token: 'access-2' })
    expect(refreshTokens(grants)).toEqual(['refresh-1'])
  })

  it('keeps the old refresh token after an unknown answer and replays it', async () => {
    let answer: LinearTokenResult = { kind: 'unknown' }
    const { access, grants, advance, at } = await setup(async () => answer)
    advance(24 * HOUR - 60_000)
    expect(await access()).toEqual({ kind: 'ok', token: 'access-1' })
    advance(60_000)
    expect(await access()).toEqual({ kind: 'retry' })
    answer = rotated(2, at() + 24 * HOUR)
    expect(await access()).toEqual({ kind: 'ok', token: 'access-2' })
    expect(refreshTokens(grants)).toEqual(['refresh-1', 'refresh-1', 'refresh-1'])
  })

  it('removes the install when Linear refuses the refresh token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { database, access, grants, advance } = await setup(async () => ({
      kind: 'failed',
      error: 'invalid_grant'
    }))
    advance(24 * HOUR)
    expect(await access()).toEqual({ kind: 'missing' })
    expect(await access()).toEqual({ kind: 'missing' })
    expect(grants).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await database.query('SELECT * FROM linear_test_installs')).toEqual([])
    warn.mockRestore()
  })

  it('keeps the install when Linear refuses for another reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { access, advance } = await setup(async () => ({
      kind: 'failed',
      error: 'invalid_client'
    }))
    advance(24 * HOUR - 60_000)
    expect(await access()).toEqual({ kind: 'ok', token: 'access-1' })
    advance(60_000)
    expect(await access()).toEqual({ kind: 'retry' })
    warn.mockRestore()
  })

  it('refreshes once when two callers find the token near expiry together', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const env = await setup(async () => {
      await held
      return rotated(2, env.at() + 24 * HOUR)
    })
    env.advance(25 * HOUR)
    const first = env.access()
    const second = env.access()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const results = await Promise.all([first, second])
    expect(env.grants).toHaveLength(1)
    expect(results[0]).toEqual({ kind: 'ok', token: 'access-2' })
    // SQLite queues the second caller behind the first; Postgres' try-lock turns it away.
    expect([
      { kind: 'ok', token: 'access-2' },
      { kind: 'retry', afterMs: 5_000 }
    ]).toContainEqual(results[1])
  })

  it('leaves a workspace another instance is refreshing, serving the token while valid', async () => {
    const env = await setup(async () => rotated(2, env.at() + 24 * HOUR))
    const locked: CloudDatabase = {
      ...env.database,
      query: (sql, params) => env.database.query(sql, params),
      transaction: (run) =>
        env.database.transaction((transaction) =>
          run({
            ...transaction,
            query: transaction.query.bind(transaction),
            tryLockScope: async () => false
          })
        )
    }
    env.advance(24 * HOUR - 60_000)
    expect(await env.access(locked)).toEqual({ kind: 'ok', token: 'access-1' })
    env.advance(60_000)
    expect(await env.access(locked)).toEqual({ kind: 'retry', afterMs: 5_000 })
    expect(env.grants).toEqual([])
  })
})
