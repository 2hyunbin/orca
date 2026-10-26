import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { openSecret, sealSecret } from './slack-sealing.js'

export type SlackAppCredentials = {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

// One row per Slack app Orca serves: a company's own copy, or one registered by an operator. Its
// signing secret verifies the requests Slack sends to that app's own URLs.
export class SlackApps {
  constructor(private readonly tokenKey: Buffer) {}

  // Null for an unknown app. A row that won't open (another key, corrupted) throws: that is an
  // operator fault, not a bad request.
  async signingSecret(database: CloudDatabase, appId: string): Promise<string | null> {
    const [row] = await database.query(
      'SELECT signing_secret FROM connector_slack_apps WHERE app_id = ?',
      [appId]
    )
    return row
      ? openSecret(this.tokenKey, 'slack-signing-secret', [appId], String(row.signing_secret))
      : null
  }

  async save(database: CloudDatabase, app: SlackAppCredentials, now: number): Promise<void> {
    await database.query(
      `INSERT INTO connector_slack_apps (app_id, client_id, client_secret, signing_secret, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (app_id) DO UPDATE SET client_id = excluded.client_id,
         client_secret = excluded.client_secret, signing_secret = excluded.signing_secret`,
      [
        app.appId,
        app.clientId,
        sealSecret(this.tokenKey, 'slack-client-secret', [app.appId], app.clientSecret),
        sealSecret(this.tokenKey, 'slack-signing-secret', [app.appId], app.signingSecret),
        now
      ]
    )
  }
}
