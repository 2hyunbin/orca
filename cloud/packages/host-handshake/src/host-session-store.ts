import { createHash, randomBytes } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'

export type HostSessionStoreConfig = {
  // Columns: token_hash, host_fingerprint (unique), expires_at, created_at.
  table: string
  // Advisory-lock prefix serializing one host's session swap; keep it stable across deploys.
  lockScope: string
  ttlMs: number
  // Columns: host_id, revoked_at. When set, every lookup joins it: a session counts only while its host is linked.
  linkTable?: string
}

export type IssuedHostSession = {
  sessionToken: string
  expiresAt: number
  hostFingerprint: string
}

export type HostSessionLookup =
  // sessionId is the stored token hash: it names the session row, and is never the token.
  | { ok: true; hostFingerprint: string; expiresAt: number; sessionId: string }
  | {
      ok: false
      reason: 'unknown_session' | 'session_expired' | 'host_not_linked' | 'host_revoked'
    }

// The advisory lock serializing one host's session swap; hold it too when changing what guards it.
export function hostSessionLockKey(lockScope: string, hostFingerprint: string): string {
  return `${lockScope}:${hostFingerprint}`
}

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('base64url')
}

export class HostSessionStore {
  constructor(
    private readonly database: CloudDatabase,
    private readonly config: HostSessionStoreConfig,
    private readonly now: () => number = Date.now
  ) {}

  // `guard` runs under the host's session lock, so a caller changing the host's standing under
  // the same lock runs wholly before or after it. A non-null result refuses the session.
  async create<Refusal = never>(
    hostFingerprint: string,
    guard?: (transaction: CloudDatabase) => Promise<Refusal | null>
  ): Promise<IssuedHostSession | Refusal> {
    const sessionToken = randomBytes(32).toString('base64url')
    const createdAt = this.now()
    const expiresAt = createdAt + this.config.ttlMs
    const refusal = await this.database.transaction(async (transaction): Promise<Refusal | null> => {
      // One active session per desktop bounds rows even for self-minted hosts that flood proofs.
      await transaction.lockQuotaScope(hostSessionLockKey(this.config.lockScope, hostFingerprint))
      const refused = guard ? await guard(transaction) : null
      if (refused !== null) return refused
      await transaction.query(`DELETE FROM ${this.config.table} WHERE host_fingerprint = ?`, [
        hostFingerprint
      ])
      await transaction.query(
        `INSERT INTO ${this.config.table} (token_hash, host_fingerprint, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
        [hashSessionToken(sessionToken), hostFingerprint, expiresAt, createdAt]
      )
      return null
    })
    return refusal ?? { sessionToken, expiresAt, hostFingerprint }
  }

  async resolve(sessionToken: string): Promise<HostSessionLookup> {
    const { table, linkTable } = this.config
    const sessionId = hashSessionToken(sessionToken)
    const [row] = await this.database.query(
      linkTable
        ? `SELECT s.host_fingerprint, s.expires_at, l.host_id AS linked_host, l.revoked_at
           FROM ${table} s LEFT JOIN ${linkTable} l ON l.host_id = s.host_fingerprint
           WHERE s.token_hash = ?`
        : `SELECT host_fingerprint, expires_at FROM ${table} WHERE token_hash = ?`,
      [sessionId]
    )
    if (!row) {
      return { ok: false, reason: 'unknown_session' }
    }
    // Revocation outranks expiry, so the host stops instead of re-proving.
    if (linkTable) {
      if (row.linked_host === null) {
        return { ok: false, reason: 'host_not_linked' }
      }
      if (row.revoked_at !== null) {
        return { ok: false, reason: 'host_revoked' }
      }
    }
    const expiresAt = Number(row.expires_at)
    // No skew grace here: a session that just expired should be re-minted
    // through the challenge, which is cheap and already handled by the host.
    if (this.now() > expiresAt) {
      return { ok: false, reason: 'session_expired' }
    }
    return { ok: true, hostFingerprint: String(row.host_fingerprint), expiresAt, sessionId }
  }

  async pruneExpired(): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM ${this.config.table} WHERE expires_at < ?`,
      [this.now()]
    )
    return Number(result?.changes ?? 0)
  }
}
