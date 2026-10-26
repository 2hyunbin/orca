import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_LIMITS,
  type ConnectorSignInPollResponse,
  type ConnectorSignInStartRequest
} from '@orca-cloud/connector-contract'
import { decodeCanonicalBase64, deriveHostFingerprint } from '@orca-cloud/host-handshake'
import { lockConnectorHost } from './connector-host-handshake.js'
import type { ConnectorAccount } from './host-links.js'

// Crockford-style base32 without I, O, 0 and 1, so a typed code survives being read aloud.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LENGTH = 8

export type SignInRequester = { ip: string; location?: string }

export type PendingSignIn = {
  hostName: string
  platform: string
  runtime: string
  orcaVersion: string
  requestIp: string
  requestLocation?: string
  createdAt: number
}

export type SignInDecision = 'approved' | 'denied' | 'not_found' | 'key_linked_elsewhere'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function newUserCode(): string {
  let code = ''
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(32)]
  return code
}

export function normalizeUserCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function pendingSignIn(row: SqlRow): PendingSignIn {
  return {
    hostName: String(row.host_name),
    platform: String(row.platform),
    runtime: String(row.runtime),
    orcaVersion: String(row.orca_version),
    requestIp: String(row.request_ip),
    ...(row.request_location === null ? {} : { requestLocation: String(row.request_location) }),
    createdAt: Number(row.created_at)
  }
}

// RFC 8628 device codes, except that approval hands out no secret: the machine already holds its key.
export class ConnectorSignInRequests {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number
  ) {}

  async start(
    request: ConnectorSignInStartRequest,
    requester: SignInRequester
  ): Promise<
    { deviceCode: string; userCode: string; expiresAt: number } | 'invalid_key' | 'rate_limited'
  > {
    // Approval derives the host id from this key, so refuse one it could never accept.
    if (!decodeCanonicalBase64(request.hostPublicKeyB64, 32)) return 'invalid_key'
    const now = this.now()
    const deviceCode = randomBytes(32).toString('base64url')
    const expiresAt = now + CONNECTOR_LIMITS.signInTtlMs
    const interval = CONNECTOR_LIMITS.signInPollIntervalSeconds
    return await this.database.transaction(async (transaction) => {
      // Serializes count-then-insert so concurrent starts cannot all read an under-limit total.
      await transaction.lockQuotaScope('orca-connector-sign-in-start')
      const [counts] = await transaction.query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN request_ip = ? THEN 1 ELSE 0 END) AS from_ip
         FROM connector_sign_in_requests WHERE status = 'pending' AND expires_at > ?`,
        [requester.ip, now]
      )
      if (
        Number(counts?.total ?? 0) >= CONNECTOR_LIMITS.signInPendingTotal ||
        Number(counts?.from_ip ?? 0) >= CONNECTOR_LIMITS.signInPendingPerIp
      ) {
        return 'rate_limited'
      }
      // A user-code collision is vanishingly rare; draw again rather than fail the start.
      for (;;) {
        const userCode = newUserCode()
        const [inserted] = await transaction.query(
          `INSERT INTO connector_sign_in_requests
           (device_code_hash, user_code_hash, host_public_key, host_name, platform, runtime,
            orca_version, request_ip, request_location, status, interval_seconds, next_poll_at,
            created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
           ON CONFLICT (user_code_hash) DO NOTHING`,
          [
            sha256(deviceCode),
            sha256(userCode),
            request.hostPublicKeyB64,
            request.hostName,
            request.platform,
            request.runtime,
            request.orcaVersion,
            requester.ip,
            requester.location ?? null,
            interval,
            now + interval * 1000,
            now,
            expiresAt
          ]
        )
        if (Number(inserted?.changes ?? 0) === 1) return { deviceCode, userCode, expiresAt }
      }
    })
  }

  async poll(deviceCode: string): Promise<ConnectorSignInPollResponse> {
    const now = this.now()
    const deviceCodeHash = sha256(deviceCode)
    return await this.database.transaction(async (transaction) => {
      // Concurrent polls must not both read the old throttle and overwrite each other's step.
      await transaction.lockQuotaScope(`orca-connector-sign-in-poll:${deviceCodeHash}`)
      const [row] = await transaction.query(
        `SELECT status, interval_seconds, next_poll_at, host_public_key, account_email, expires_at
         FROM connector_sign_in_requests WHERE device_code_hash = ?`,
        [deviceCodeHash]
      )
      if (!row || now > Number(row.expires_at)) {
        return { status: 'expired', interval: CONNECTOR_LIMITS.signInPollIntervalSeconds }
      }
      const early = now < Number(row.next_poll_at)
      const interval =
        Number(row.interval_seconds) + (early ? CONNECTOR_LIMITS.signInSlowDownStepSeconds : 0)
      await transaction.query(
        `UPDATE connector_sign_in_requests SET interval_seconds = ?, next_poll_at = ?
         WHERE device_code_hash = ?`,
        [interval, now + interval * 1000, deviceCodeHash]
      )
      if (early) return { status: 'slow_down', interval }
      if (row.status === 'approved') {
        const hostKey = decodeCanonicalBase64(String(row.host_public_key), 32)
        if (!hostKey) throw new Error('stored_host_key_invalid')
        return {
          status: 'authorized',
          interval,
          hostId: deriveHostFingerprint(hostKey),
          account: { email: String(row.account_email) }
        }
      }
      return { status: row.status === 'denied' ? 'denied' : 'pending', interval }
    })
  }

  async findPending(userCode: string): Promise<PendingSignIn | null> {
    const [row] = await this.database.query(
      `SELECT host_name, platform, runtime, orca_version, request_ip, request_location, created_at
       FROM connector_sign_in_requests
       WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`,
      [sha256(normalizeUserCode(userCode)), this.now()]
    )
    return row ? pendingSignIn(row) : null
  }

  async decide(
    userCode: string,
    account: ConnectorAccount,
    allow: boolean
  ): Promise<SignInDecision> {
    const now = this.now()
    const userCodeHash = sha256(normalizeUserCode(userCode))
    return await this.database.transaction(async (transaction) => {
      // Claiming the pending row first makes a concurrent second decision find nothing.
      const [claimed] = await transaction.query(
        `UPDATE connector_sign_in_requests SET status = ?, account_email = ?
         WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?
         RETURNING host_public_key, host_name, platform, runtime, orca_version`,
        [allow ? 'approved' : 'denied', allow ? account.email : null, userCodeHash, now]
      )
      if (!claimed) return 'not_found'
      if (!allow) return 'denied'
      const publicKey = String(claimed.host_public_key)
      const hostKey = decodeCanonicalBase64(publicKey, 32)
      if (!hostKey) throw new Error('stored_host_key_invalid')
      const hostId = deriveHostFingerprint(hostKey)
      await lockConnectorHost(transaction, hostId)
      const [existing] = await transaction.query(
        'SELECT account_id FROM connector_hosts WHERE host_id = ?',
        [hostId]
      )
      if (existing && existing.account_id !== account.id) {
        await transaction.query(
          `UPDATE connector_sign_in_requests SET status = 'denied', account_email = NULL
           WHERE user_code_hash = ?`,
          [userCodeHash]
        )
        return 'key_linked_elsewhere'
      }
      await transaction.query(
        `INSERT INTO connector_hosts
         (host_id, public_key, account_id, account_email, host_name, platform, runtime,
          orca_version, linked_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (host_id) DO UPDATE SET account_email = excluded.account_email,
           host_name = excluded.host_name, platform = excluded.platform,
           runtime = excluded.runtime, orca_version = excluded.orca_version,
           linked_at = excluded.linked_at, revoked_at = NULL`,
        [
          hostId,
          publicKey,
          account.id,
          account.email,
          claimed.host_name,
          claimed.platform,
          claimed.runtime,
          claimed.orca_version,
          now
        ]
      )
      // A relink starts clean: no session from an earlier link carries over.
      await transaction.query('DELETE FROM connector_sessions WHERE host_fingerprint = ?', [hostId])
      return 'approved'
    })
  }

  async pruneFinished(retentionMs: number): Promise<number> {
    const [result] = await this.database.query(
      'DELETE FROM connector_sign_in_requests WHERE expires_at < ?',
      [this.now() - retentionMs]
    )
    return Number(result?.changes ?? 0)
  }
}
