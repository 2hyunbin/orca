import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fenceWithSession, scramSha256Verifier, setOwnPassword } from './database-move-fence.js'
import { withPgClient } from './test-fixtures/database-move-sides.js'

const adminUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = adminUrl ? describe : describe.skip

const role = `mv_fence_${randomBytes(4).toString('hex')}`
const password = randomBytes(12).toString('hex')

function roleUrl(secret: string): string {
  const url = new URL(adminUrl ?? 'postgres://localhost')
  url.username = role
  url.password = secret
  url.pathname = `/${role}`
  return url.toString()
}

async function login(secret: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: roleUrl(secret) })
  client.on('error', () => undefined)
  await client.connect()
  return client
}

async function loginError(secret: string): Promise<string | undefined> {
  try {
    await (await login(secret)).end()
    return undefined
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'unknown'
  }
}

describePostgres('database move fence', () => {
  beforeAll(async () => {
    await withPgClient(adminUrl ?? '', async (admin) => {
      await admin.query(`CREATE ROLE ${role} LOGIN NOCREATEROLE NOSUPERUSER PASSWORD '${password}'`)
      await admin.query(`CREATE DATABASE ${role} OWNER ${role}`)
    })
  })

  afterAll(async () => {
    await withPgClient(adminUrl ?? '', async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`)
      await admin.query(`DROP ROLE IF EXISTS ${role}`)
    })
  })

  it('locks out new logins, keeps existing sessions until terminated, and restores from the session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const held = await login(password)
    const other = await login(password)
    const attributes = await held.query(
      `SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user`
    )
    expect(attributes.rows[0]).toEqual({ rolcreaterole: false, rolsuper: false })

    // Self password change: no CREATEROLE needed.
    await setOwnPassword(held, randomBytes(16).toString('hex'))
    expect(await loginError(password)).toBe('28P01')
    // A session that already logged in is not affected by the password.
    expect((await other.query('SELECT 1 AS ok')).rows[0]?.ok).toBe(1)

    // Self-termination: the role ends its own other sessions, and the held one survives.
    const fence = await fenceWithSession(held)
    expect(fence.terminated).toBe(1)
    await expect(other.query('SELECT 1')).rejects.toThrow()
    expect((await held.query('SELECT 1 AS ok')).rows[0]?.ok).toBe(1)

    // The abort path: the original password, sent as a SCRAM verifier, logs in again.
    await setOwnPassword(held, password)
    const restored = await login(password)
    expect((await restored.query('SELECT 1 AS ok')).rows[0]?.ok).toBe(1)
    await Promise.all([restored.end(), held.end(), other.end().catch(() => undefined)])
  })

  it('never sends the plaintext password', () => {
    const verifier = scramSha256Verifier(password)
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/
    )
    expect(verifier).not.toContain(password)
    expect(() => scramSha256Verifier('pässword')).toThrow('password_not_printable_ascii')
  })
})
