import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type pg from 'pg'
import { quoteLiteral } from './database-move-catalog.js'
import { logMoveEvent, MoveRefusal, sleep } from './database-move-events.js'

const SCRAM_ITERATIONS = 4096
const FENCE_SCAN_SPACING_MS = 50
const FENCE_MAX_SCANS = 400

// The password goes to the server as a SCRAM verifier, so the plaintext never appears in a
// statement the server could log (log_statement = ddl). Equal to what the server stores for
// `PASSWORD '<plaintext>'` under SCRAM-SHA-256, with a fresh salt.
export function scramSha256Verifier(password: string): string {
  // Postgres SASLprep-normalises non-ASCII passwords; refuse rather than store a different one.
  if (!/^[\x20-\x7e]+$/.test(password)) throw new MoveRefusal('password_not_printable_ascii')
  const salt = randomBytes(16)
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest('base64')
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64')
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey}:${serverKey}`
}

// A role may change its own password; no CREATEROLE, ADMIN or Cloud SQL API call is needed.
export async function setOwnPassword(session: pg.Client, password: string): Promise<void> {
  await session.query(
    `ALTER ROLE CURRENT_USER PASSWORD ${quoteLiteral(scramSha256Verifier(password))}`
  )
}

// Over the held app-role session: new logins as the relay role now fail with 28P01, and every
// other session of that role is terminated. Sessions of other roles (auth, the API, the tool
// role) are never touched.
export async function fenceWithSession(
  session: pg.Client
): Promise<{ terminated: number; scans: number }> {
  await setOwnPassword(session, randomBytes(24).toString('base64url'))
  const result = await terminateOtherSessions(session)
  logMoveEvent('fence_complete', result)
  return result
}

// Until two scans in a row find none. A login still mid-authentication when the password changed
// is not listed yet, so the cutover scans again just before it hands authority over.
export async function terminateOtherSessions(
  session: pg.Client
): Promise<{ terminated: number; scans: number }> {
  let terminated = 0
  let clean = 0
  for (let scans = 1; scans <= FENCE_MAX_SCANS; scans++) {
    const result = await session.query(
      `SELECT pid, pg_terminate_backend(pid) AS signalled FROM pg_stat_activity
       WHERE usename = current_user AND pid <> pg_backend_pid() AND backend_type = 'client backend'`
    )
    terminated += result.rows.filter((row) => row.signalled).length
    clean = result.rows.length === 0 ? clean + 1 : 0
    if (clean >= 2) return { terminated, scans }
    await sleep(FENCE_SCAN_SPACING_MS)
  }
  throw new MoveRefusal('fence_sessions_keep_appearing', { terminated })
}
