import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { LinearTokenEndpoint, LinearTokens } from './linear-oauth.js'

const REFRESH_MARGIN_MS = 5 * 60_000
// Another instance holds the workspace for at most one token request.
const LOCKED_RETRY_MS = 5_000

// The install's credentials wherever the installs table keeps them; called inside the transaction.
export type LinearCredentialStore = {
  read(database: CloudDatabase, organizationId: string): Promise<LinearTokens | null>
  write(database: CloudDatabase, organizationId: string, tokens: LinearTokens): Promise<void>
  // Linear refused the refresh token: the workspace is no longer installed.
  remove(database: CloudDatabase, organizationId: string): Promise<void>
}

export type LinearAccess =
  | { kind: 'ok'; token: string }
  | { kind: 'missing' }
  | { kind: 'retry'; afterMs?: number }

function usable(tokens: LinearTokens, nowMs: number): LinearAccess | null {
  return tokens.expiresAt > nowMs ? { kind: 'ok', token: tokens.accessToken } : null
}

// A current access token, refreshed first when it expires within five minutes. Linear rotates the
// refresh token on every use, so refreshes run one at a time per workspace and commit only after
// Linear answers; a lost answer leaves the old refresh token, which Linear replays for 30 minutes.
export async function linearAccessToken(
  deps: {
    database: CloudDatabase
    store: LinearCredentialStore
    tokenEndpoint: LinearTokenEndpoint
    now: () => number
  },
  organizationId: string
): Promise<LinearAccess> {
  const { store, now } = deps
  const current = await store.read(deps.database, organizationId)
  if (!current) {
    return { kind: 'missing' }
  }
  if (current.expiresAt - now() > REFRESH_MARGIN_MS) {
    return { kind: 'ok', token: current.accessToken }
  }
  return await deps.database.transaction(async (transaction) => {
    // Try-lock: the holder can wait on Linear longer than the database's lock timeout.
    if (!(await transaction.tryLockScope(`orca-connector-linear-token:${organizationId}`))) {
      return usable(current, now()) ?? { kind: 'retry', afterMs: LOCKED_RETRY_MS }
    }
    const held = await store.read(transaction, organizationId)
    if (!held) {
      return { kind: 'missing' }
    }
    if (held.expiresAt - now() > REFRESH_MARGIN_MS) {
      return { kind: 'ok', token: held.accessToken }
    }
    const refreshed = await deps.tokenEndpoint({
      grantType: 'refresh_token',
      refreshToken: held.refreshToken
    })
    if (refreshed.kind === 'ok') {
      await store.write(transaction, organizationId, refreshed.tokens)
      return { kind: 'ok', token: refreshed.tokens.accessToken }
    }
    if (refreshed.kind === 'failed' && refreshed.error === 'invalid_grant') {
      await store.remove(transaction, organizationId)
      console.warn(
        JSON.stringify({ event: 'orca_connector_linear_install_revoked', organizationId })
      )
      return { kind: 'missing' }
    }
    if (refreshed.kind === 'failed') {
      console.warn(
        JSON.stringify({ event: 'orca_connector_linear_refresh_refused', error: refreshed.error })
      )
    }
    return usable(held, now()) ?? { kind: 'retry' }
  })
}
