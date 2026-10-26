import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import type { LinearTokenEndpoint, LinearTokens } from './linear-oauth.js'
import { openBotToken, sealBotToken } from './slack-installs.js'

// Access tokens last 24 h; refresh with an hour left so a failed refresh still has a working token.
const REFRESH_MARGIN_MS = 60 * 60_000
// Another instance holds the row for at most one token request.
const LOCKED_RETRY_MS = 5_000

export type LinearInstall = { organizationId: string; appUserId: string; paused: boolean }

export type LinearAccess =
  | { kind: 'ok'; token: string }
  // No install, a token sealed under another key, or Linear refused the refresh: reinstall.
  | { kind: 'missing' }
  | { kind: 'retry'; afterMs?: number }

type TokenRow = { accessToken: string | null; refreshToken: string | null; expiresAt: number }

// Each sealed token is bound to its workspace and its role, so neither opens in another row or column.
const seal = (key: Buffer, organizationId: string, role: string, token: string) =>
  sealBotToken(key, `${organizationId}:${role}`, token)

function open(key: Buffer, organizationId: string, role: string, sealed: unknown): string | null {
  try {
    return openBotToken(key, `${organizationId}:${role}`, String(sealed))
  } catch {
    return null
  }
}

// One row per Linear workspace, written by the OAuth install. Linear rotates the refresh token on
// every refresh, so refreshes run one at a time per workspace under the row lock.
export class LinearInstalls {
  constructor(
    private readonly tokenKey: Buffer,
    private readonly tokenEndpoint: LinearTokenEndpoint,
    private readonly now: () => number
  ) {}

  async find(database: CloudDatabase, organizationId: string): Promise<LinearInstall | null> {
    const [row] = await database.query(
      'SELECT app_user_id, paused FROM connector_linear_installs WHERE organization_id = ?',
      [organizationId]
    )
    return row
      ? { organizationId, appUserId: String(row.app_user_id), paused: Number(row.paused) === 1 }
      : null
  }

  async save(
    database: CloudDatabase,
    install: { organizationId: string; appUserId: string; tokens: LinearTokens }
  ): Promise<void> {
    const { organizationId, tokens } = install
    await database.query(
      `INSERT INTO connector_linear_installs
         (organization_id, app_user_id, access_token, refresh_token, expires_at, paused, installed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (organization_id) DO UPDATE SET app_user_id = excluded.app_user_id,
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, installed_at = excluded.installed_at`,
      [
        organizationId,
        install.appUserId,
        seal(this.tokenKey, organizationId, 'access', tokens.accessToken),
        seal(this.tokenKey, organizationId, 'refresh', tokens.refreshToken),
        tokens.expiresAt,
        this.now()
      ]
    )
  }

  async setPaused(
    database: CloudDatabase,
    organizationId: string,
    paused: boolean
  ): Promise<boolean> {
    const [result] = await database.query(
      'UPDATE connector_linear_installs SET paused = ? WHERE organization_id = ?',
      [paused ? 1 : 0, organizationId]
    )
    return Number(result?.changes ?? 0) > 0
  }

  // A current access token, refreshing it first when it is near expiry.
  async accessToken(database: CloudDatabase, organizationId: string): Promise<LinearAccess> {
    const [row] = await database.query(
      'SELECT access_token, refresh_token, expires_at FROM connector_linear_installs WHERE organization_id = ?',
      [organizationId]
    )
    if (!row) {
      return { kind: 'missing' }
    }
    const current = this.tokens(organizationId, row)
    if (current.expiresAt - this.now() > REFRESH_MARGIN_MS) {
      return this.usable(current) ?? { kind: 'missing' }
    }
    return await database.transaction(async (transaction) => {
      // SKIP LOCKED: an instance already refreshing this workspace is left to finish.
      const lock = transaction.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''
      const [locked] = await transaction.query(
        `SELECT access_token, refresh_token, expires_at FROM connector_linear_installs
         WHERE organization_id = ?${lock}`,
        [organizationId]
      )
      if (!locked) {
        return this.usable(current) ?? { kind: 'retry', afterMs: LOCKED_RETRY_MS }
      }
      const held = this.tokens(organizationId, locked)
      if (held.expiresAt - this.now() > REFRESH_MARGIN_MS) {
        return this.usable(held) ?? { kind: 'missing' }
      }
      if (held.refreshToken === null) {
        return { kind: 'missing' }
      }
      const refreshed = await this.tokenEndpoint({
        grantType: 'refresh_token',
        refreshToken: held.refreshToken
      })
      // Unknown keeps the old refresh token stored: Linear replays its answer for 30 minutes.
      if (refreshed.kind !== 'ok') {
        return (
          this.usable(held) ??
          (refreshed.kind === 'failed' ? { kind: 'missing' } : { kind: 'retry' })
        )
      }
      const { tokens } = refreshed
      await transaction.query(
        `UPDATE connector_linear_installs SET access_token = ?, refresh_token = ?, expires_at = ?
         WHERE organization_id = ?`,
        [
          seal(this.tokenKey, organizationId, 'access', tokens.accessToken),
          seal(this.tokenKey, organizationId, 'refresh', tokens.refreshToken),
          tokens.expiresAt,
          organizationId
        ]
      )
      return { kind: 'ok', token: tokens.accessToken }
    })
  }

  private tokens(organizationId: string, row: SqlRow): TokenRow {
    return {
      accessToken: open(this.tokenKey, organizationId, 'access', row.access_token),
      refreshToken: open(this.tokenKey, organizationId, 'refresh', row.refresh_token),
      expiresAt: Number(row.expires_at)
    }
  }

  // The stored access token while it has not yet expired.
  private usable(tokens: TokenRow): LinearAccess | null {
    return tokens.accessToken !== null && tokens.expiresAt > this.now()
      ? { kind: 'ok', token: tokens.accessToken }
      : null
  }
}
