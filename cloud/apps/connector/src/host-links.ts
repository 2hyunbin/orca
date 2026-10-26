import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import { lockConnectorHost } from './connector-host-handshake.js'
import type { ConnectorInbox } from './connector-inbox.js'

// Coarse on purpose: last-seen is written at most once a minute per host.
const LAST_SEEN_RESOLUTION_MS = 60_000

export type ConnectorAccount = { id: string; email: string }

export type LinkedHost = {
  hostId: string
  hostName: string
  platform: string
  runtime: string
  orcaVersion: string
  linkedAt: number
}

export type HostLinkRefusal = 'host_not_linked' | 'host_revoked'

// A host is linked to the one account that approved its key; logout deletes the link, revoke keeps it as revoked.
export class ConnectorHostLinks {
  constructor(
    private readonly database: CloudDatabase,
    private readonly inbox: ConnectorInbox,
    private readonly now: () => number
  ) {}

  // Run under lockConnectorHost (session creation's guard), so no link change interleaves.
  async refusal(transaction: CloudDatabase, hostId: string): Promise<HostLinkRefusal | null> {
    const [row] = await transaction.query(
      'SELECT revoked_at FROM connector_hosts WHERE host_id = ?',
      [hostId]
    )
    if (!row) return 'host_not_linked'
    return row.revoked_at === null ? null : 'host_revoked'
  }

  async listForAccount(accountId: string): Promise<LinkedHost[]> {
    const rows = await this.database.query(
      `SELECT host_id, host_name, platform, runtime, orca_version, linked_at FROM connector_hosts
       WHERE account_id = ? AND revoked_at IS NULL ORDER BY linked_at DESC`,
      [accountId]
    )
    return rows.map((row) => ({
      hostId: String(row.host_id),
      hostName: String(row.host_name),
      platform: String(row.platform),
      runtime: String(row.runtime),
      orcaVersion: String(row.orca_version),
      linkedAt: Number(row.linked_at)
    }))
  }

  async revoke(accountId: string, hostId: string): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      await lockConnectorHost(transaction, hostId)
      const [revoked] = await transaction.query(
        `UPDATE connector_hosts SET revoked_at = ?
         WHERE host_id = ? AND account_id = ? AND revoked_at IS NULL`,
        [this.now(), hostId, accountId]
      )
      if (Number(revoked?.changes ?? 0) === 0) return false
      await transaction.query('DELETE FROM connector_sessions WHERE host_fingerprint = ?', [hostId])
      await this.inbox.expireHost(transaction, hostId)
      return true
    })
  }

  async unbind(hostId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockConnectorHost(transaction, hostId)
      await transaction.query('DELETE FROM connector_hosts WHERE host_id = ?', [hostId])
      await transaction.query('DELETE FROM connector_sessions WHERE host_fingerprint = ?', [hostId])
      await this.inbox.expireHost(transaction, hostId)
    })
  }

  async accountOf(hostId: string): Promise<string | null> {
    const [row] = await this.database.query(
      'SELECT account_id FROM connector_hosts WHERE host_id = ? AND revoked_at IS NULL',
      [hostId]
    )
    return row ? String(row.account_id) : null
  }

  // The latest hello wins; a poll naming another revision is told to send hello again.
  async recordHello(hostId: string, hello: ConnectorHelloRequest): Promise<void> {
    const now = this.now()
    await this.database.query(
      `UPDATE connector_hosts SET hello_rev = ?, hello = ?, host_name = ?, platform = ?,
         runtime = ?, orca_version = ?, last_seen_at = ?
       WHERE host_id = ?`,
      [
        hello.helloRev,
        JSON.stringify(hello),
        hello.hostName,
        hello.platform,
        hello.runtime,
        hello.orcaVersion,
        now,
        hostId
      ]
    )
  }

  async helloRev(hostId: string): Promise<number | null> {
    const [row] = await this.database.query(
      'SELECT hello_rev FROM connector_hosts WHERE host_id = ?',
      [hostId]
    )
    return row?.hello_rev === null || row?.hello_rev === undefined ? null : Number(row.hello_rev)
  }

  async touch(hostId: string): Promise<void> {
    const now = this.now()
    await this.database.query(
      `UPDATE connector_hosts SET last_seen_at = ?
       WHERE host_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      [now, hostId, now - LAST_SEEN_RESOLUTION_MS]
    )
  }
}
