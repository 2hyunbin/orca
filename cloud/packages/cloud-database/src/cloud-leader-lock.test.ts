import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { acquireLeadership } from './cloud-leader-lock.js'

const postgresUrl = process.env.ORCA_CLOUD_DATABASE_TEST_URL

describe('acquireLeadership', () => {
  it('leads at once without a database', async () => {
    const leadership = await acquireLeadership({
      key: 'gateway',
      signal: new AbortController().signal
    })
    await leadership.release()
    await expect(leadership.lost).resolves.toBeUndefined()
  })

  it.skipIf(!postgresUrl)(
    'lets one holder lead until it releases or its session dies',
    async () => {
      const key = `gateway-${randomUUID()}`
      const options = { databaseUrl: postgresUrl, key, pollMs: 50, checkMs: 50 }
      const first = await acquireLeadership({ ...options, signal: AbortSignal.timeout(5_000) })
      let secondLed = false
      const second = acquireLeadership({ ...options, signal: AbortSignal.timeout(5_000) }).then(
        (leadership) => {
          secondLed = true
          return leadership
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(secondLed).toBe(false)
      await first.release()
      const next = await second

      // Killing the leader's session frees the lock and the holder notices.
      const admin = new pg.Client({ connectionString: postgresUrl })
      await admin.connect()
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
       WHERE locktype = 'advisory' AND objid = hashtext($1::text)::oid AND granted`,
        [key]
      )
      await admin.end()
      await next.lost
      const third = await acquireLeadership({ ...options, signal: AbortSignal.timeout(5_000) })
      await third.release()
    }
  )

  it.skipIf(!postgresUrl)('stops waiting when aborted', async () => {
    const key = `gateway-${randomUUID()}`
    const options = { databaseUrl: postgresUrl, key, pollMs: 50 }
    const first = await acquireLeadership({ ...options, signal: AbortSignal.timeout(5_000) })
    await expect(
      acquireLeadership({ ...options, signal: AbortSignal.timeout(200) })
    ).rejects.toThrow()
    await first.release()
  })
})
