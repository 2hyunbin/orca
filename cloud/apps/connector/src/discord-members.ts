import type { CloudDatabase } from '@orca-cloud/cloud-database'

const inList = (ids: string[]) => ids.map(() => '?').join(', ')

// Decisions §15: on Discord only linked people's words reach an agent. Their names come from their
// own messages, so labelling them never needs a lookup.
export class DiscordMembers {
  constructor(private readonly now: () => number) {}

  // Under the routing transaction, for the message being routed.
  async remember(
    transaction: CloudDatabase,
    member: { guildId: string; userId: string; userName: string }
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO connector_discord_members (guild_id, user_id, display_name, seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET display_name = excluded.display_name,
         seen_at = excluded.seen_at`,
      [member.guildId, member.userId, member.userName, this.now()]
    )
  }

  async trustedNames(
    transaction: CloudDatabase,
    guildId: string,
    userIds: string[]
  ): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) {
      return new Map()
    }
    const rows = await transaction.query(
      `SELECT m.user_id, m.display_name FROM connector_discord_members m
       JOIN connector_identities i
         ON i.source = 'discord' AND i.workspace_id = m.guild_id AND i.user_id = m.user_id
       WHERE m.guild_id = ? AND m.user_id IN (${inList(unique)})`,
      [guildId, ...unique]
    )
    return new Map(rows.map((row) => [String(row.user_id), String(row.display_name)]))
  }

  async linked(database: CloudDatabase, guildId: string, userIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)]
    if (unique.length === 0) {
      return new Set()
    }
    const rows = await database.query(
      `SELECT user_id FROM connector_identities
       WHERE source = 'discord' AND workspace_id = ? AND user_id IN (${inList(unique)})`,
      [guildId, ...unique]
    )
    return new Set(rows.map((row) => String(row.user_id)))
  }
}
