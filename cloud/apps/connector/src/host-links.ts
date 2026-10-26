import type { CloudDatabase } from '@orca-cloud/cloud-database'

export type ConnectorAccount = { id: string; email: string }

export type LinkedHost = {
  hostId: string
  hostName: string
  platform: string
  runtime: string
  orcaVersion: string
  linkedAt: number
}

export type HostLinkStatus = 'linked' | 'revoked' | 'not_linked'

// A host is linked to the one account that approved its key; logout deletes the link, revoke keeps it as revoked.
export class ConnectorHostLinks {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number
  ) {}

  async status(hostId: string): Promise<HostLinkStatus> {
    const [row] = await this.database.query(
      'SELECT revoked_at FROM connector_hosts WHERE host_id = ?',
      [hostId]
    )
    if (!row) return 'not_linked'
    return row.revoked_at === null ? 'linked' : 'revoked'
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
      const [revoked] = await transaction.query(
        `UPDATE connector_hosts SET revoked_at = ?
         WHERE host_id = ? AND account_id = ? AND revoked_at IS NULL`,
        [this.now(), hostId, accountId]
      )
      if (Number(revoked?.changes ?? 0) === 0) return false
      await transaction.query('DELETE FROM connector_sessions WHERE host_fingerprint = ?', [hostId])
      return true
    })
  }

  async unbind(hostId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query('DELETE FROM connector_hosts WHERE host_id = ?', [hostId])
      await transaction.query('DELETE FROM connector_sessions WHERE host_fingerprint = ?', [hostId])
    })
  }
}
