import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { openSecret, sealSecret } from './slack-sealing.js'

export type SlackInstall = { teamId: string; appId: string; botUserId: string; paused: boolean }

// One row per Slack workspace: which Orca app is installed there, and its bot. A workspace has at
// most one Orca app.
export class SlackInstalls {
  constructor(private readonly tokenKey: Buffer) {}

  async find(database: CloudDatabase, teamId: string): Promise<SlackInstall | null> {
    const [row] = await database.query(
      'SELECT app_id, bot_user_id, paused FROM connector_slack_installs WHERE team_id = ?',
      [teamId]
    )
    return row
      ? {
          teamId,
          appId: String(row.app_id),
          botUserId: String(row.bot_user_id),
          paused: Number(row.paused) === 1
        }
      : null
  }

  async botToken(database: CloudDatabase, teamId: string): Promise<string | null> {
    const [row] = await database.query(
      'SELECT app_id, bot_token FROM connector_slack_installs WHERE team_id = ?',
      [teamId]
    )
    if (!row) {
      return null
    }
    // Sealed under another key or corrupted: as good as no install.
    try {
      return openSecret(
        this.tokenKey,
        'slack-bot-token',
        [teamId, String(row.app_id)],
        String(row.bot_token)
      )
    } catch {
      return null
    }
  }

  // False when the workspace already has a different Orca app; a reinstall of the same app updates
  // its row in place.
  async save(
    database: CloudDatabase,
    install: { teamId: string; appId: string; botUserId: string; botToken: string },
    now: number
  ): Promise<boolean> {
    const [result] = await database.query(
      `INSERT INTO connector_slack_installs
       (team_id, app_id, bot_user_id, bot_token, paused, installed_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (team_id) DO UPDATE SET bot_user_id = excluded.bot_user_id,
         bot_token = excluded.bot_token, installed_at = excluded.installed_at
       WHERE connector_slack_installs.app_id = excluded.app_id`,
      [
        install.teamId,
        install.appId,
        install.botUserId,
        sealSecret(
          this.tokenKey,
          'slack-bot-token',
          [install.teamId, install.appId],
          install.botToken
        ),
        now
      ]
    )
    return Number(result?.changes ?? 0) > 0
  }

  async setPaused(database: CloudDatabase, teamId: string, paused: boolean): Promise<boolean> {
    const [result] = await database.query(
      'UPDATE connector_slack_installs SET paused = ? WHERE team_id = ?',
      [paused ? 1 : 0, teamId]
    )
    return Number(result?.changes ?? 0) > 0
  }
}
