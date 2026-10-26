import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorEvent } from '@orca-cloud/connector-contract'

export type NewThread = {
  externalId: string
  teamId: string
  channelId: string
  threadTs: string
  ownerUserId: string
  accountId: string
  hostId: string
  placeId: string
}

// Each Slack thread is bound to one host for life; events only ever touch that host's threads.
export class ConnectorThreads {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number
  ) {}

  async create(thread: NewThread): Promise<void> {
    await this.database.query(
      `INSERT INTO connector_threads
       (external_id, team_id, channel_id, thread_ts, owner_user_id, account_id, host_id, place_id,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (external_id) DO NOTHING`,
      [
        thread.externalId,
        thread.teamId,
        thread.channelId,
        thread.threadTs,
        thread.ownerUserId,
        thread.accountId,
        thread.hostId,
        thread.placeId,
        this.now()
      ]
    )
  }

  async hostOf(externalId: string): Promise<string | null> {
    const [row] = await this.database.query(
      'SELECT host_id FROM connector_threads WHERE external_id = ?',
      [externalId]
    )
    return row ? String(row.host_id) : null
  }

  // Idempotent by each event's identity: a resend writes the same state again or matches nothing.
  async applyEvents(hostId: string, events: ConnectorEvent[]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      for (const event of events) {
        if (event.kind === 'snapshot') {
          for (const entry of event.conversations) {
            // Not working never means done: an open turn the machine no longer shows is unverifiable.
            await transaction.query(
              `UPDATE connector_threads SET pane_key = ?, agent = ?, pending_prompt = ?,
                 turn_state = CASE WHEN turn_state = 'working' AND ? = 0 THEN 'unverifiable'
                   ELSE turn_state END
               WHERE host_id = ? AND external_id = ?`,
              [
                entry.paneKey,
                entry.agent,
                entry.prompt ? JSON.stringify(entry.prompt) : null,
                entry.working ? 1 : 0,
                hostId,
                entry.conversation.externalId
              ]
            )
          }
          continue
        }
        const where = [hostId, event.conversation.externalId]
        switch (event.kind) {
          case 'linked':
            await transaction.query(
              `UPDATE connector_threads SET pane_key = ?, agent = ?
               WHERE host_id = ? AND external_id = ?`,
              [event.paneKey, event.agent, ...where]
            )
            break
          case 'prompt':
            await transaction.query(
              `UPDATE connector_threads SET pane_key = ?, pending_prompt = ?
               WHERE host_id = ? AND external_id = ?`,
              [event.paneKey, JSON.stringify(event.prompt), ...where]
            )
            break
          case 'turn-started':
            await transaction.query(
              `UPDATE connector_threads SET pane_key = ?, open_turn_id = ?, turn_state = 'working',
                 turn_stop_reason = NULL, turn_last_message = NULL, pending_prompt = NULL
               WHERE host_id = ? AND external_id = ? AND (open_turn_id IS NULL OR open_turn_id < ?)`,
              [event.paneKey, event.at, ...where, event.at]
            )
            break
          case 'turn-ended':
            await transaction.query(
              `UPDATE connector_threads SET pane_key = ?, open_turn_id = ?, turn_state = 'ended',
                 turn_stop_reason = ?, turn_last_message = ?, pending_prompt = NULL
               WHERE host_id = ? AND external_id = ? AND (open_turn_id IS NULL OR open_turn_id <= ?)`,
              [
                event.paneKey,
                event.turnId,
                event.stopReason,
                event.lastAssistantMessage ?? null,
                ...where,
                event.turnId
              ]
            )
            break
        }
      }
    })
  }
}
