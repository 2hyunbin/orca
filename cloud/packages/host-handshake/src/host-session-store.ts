import { createHash, randomBytes } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'

export type HostSessionStoreConfig = {
  // Columns: token_hash, host_fingerprint (unique), expires_at, created_at.
  table: string
  // Advisory-lock prefix serializing one host's session swap; keep it stable across deploys.
  lockScope: string
  ttlMs: number
}

export type IssuedHostSession = {
  sessionToken: string
  expiresAt: number
  hostFingerprint: string
}

export type HostSessionLookup =
  | { ok: true; hostFingerprint: string; expiresAt: number }
  | { ok: false; reason: 'unknown_session' | 'session_expired' }

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('base64url')
}

export class HostSessionStore {
  constructor(
    private readonly database: CloudDatabase,
    private readonly config: HostSessionStoreConfig,
    private readonly now: () => number = Date.now
  ) {}

  async create(hostFingerprint: string): Promise<IssuedHostSession> {
    const sessionToken = randomBytes(32).toString('base64url')
    const createdAt = this.now()
    const expiresAt = createdAt + this.config.ttlMs
    await this.database.transaction(async (transaction) => {
      // One active session per desktop bounds rows even for self-minted hosts that flood proofs.
      await transaction.lockQuotaScope(`${this.config.lockScope}:${hostFingerprint}`)
      await transaction.query(`DELETE FROM ${this.config.table} WHERE host_fingerprint = ?`, [
        hostFingerprint
      ])
      await transaction.query(
        `INSERT INTO ${this.config.table} (token_hash, host_fingerprint, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
        [hashSessionToken(sessionToken), hostFingerprint, expiresAt, createdAt]
      )
    })
    return { sessionToken, expiresAt, hostFingerprint }
  }

  async resolve(sessionToken: string): Promise<HostSessionLookup> {
    const [row] = await this.database.query(
      `SELECT host_fingerprint, expires_at FROM ${this.config.table} WHERE token_hash = ?`,
      [hashSessionToken(sessionToken)]
    )
    if (!row) return { ok: false, reason: 'unknown_session' }
    const expiresAt = Number(row.expires_at)
    // No skew grace here: a session that just expired should be re-minted
    // through the challenge, which is cheap and already handled by the host.
    if (this.now() > expiresAt) return { ok: false, reason: 'session_expired' }
    return { ok: true, hostFingerprint: String(row.host_fingerprint), expiresAt }
  }

  async pruneExpired(): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM ${this.config.table} WHERE expires_at < ?`,
      [this.now()]
    )
    return Number(result?.changes ?? 0)
  }
}
