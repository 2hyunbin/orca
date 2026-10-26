import { openInMemoryCloudDatabase, type CloudDatabase } from '@orca-cloud/cloud-database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostSessionStore } from './host-session-store.js'

const HOST = 'abcdefghijklmnop'

describe('host session link join', () => {
  let database: CloudDatabase
  let sessions: HostSessionStore

  beforeEach(async () => {
    database = await openInMemoryCloudDatabase([
      `CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, host_fingerprint TEXT NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)`,
      'CREATE TABLE hosts (host_id TEXT PRIMARY KEY, revoked_at BIGINT)'
    ])
    sessions = new HostSessionStore(database, {
      table: 'sessions',
      lockScope: 'test-session',
      ttlMs: 60_000,
      linkTable: 'hosts'
    })
  })

  afterEach(async () => {
    await database.close()
  })

  it('admits a session only while its host is linked and not revoked', async () => {
    const { sessionToken } = await sessions.create(HOST)
    await expect(sessions.resolve(sessionToken)).resolves.toEqual({
      ok: false,
      reason: 'host_not_linked'
    })
    await database.query('INSERT INTO hosts (host_id, revoked_at) VALUES (?, NULL)', [HOST])
    await expect(sessions.resolve(sessionToken)).resolves.toMatchObject({
      ok: true,
      hostFingerprint: HOST
    })
    await database.query('UPDATE hosts SET revoked_at = 1 WHERE host_id = ?', [HOST])
    await expect(sessions.resolve(sessionToken)).resolves.toEqual({
      ok: false,
      reason: 'host_revoked'
    })
  })
})
