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
  constructor(private readonly now: () => number) {}

  // Binds the thread to its host on first sight; false when it already belongs to another host.
  async bind(transaction: CloudDatabase, thread: NewThread): Promise<boolean> {
    await transaction.query(
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
    const [row] = await transaction.query(
      'SELECT host_id FROM connector_threads WHERE external_id = ?',
      [thread.externalId]
    )
    return row?.host_id === thread.hostId
  }

  // Idempotent by each event's identity: a resend writes the same state again or matches nothing.
  // Under the host lock (MachineSession.locked), so a replaced or revoked session writes nothing.
  async applyEvents(
    transaction: CloudDatabase,
    hostId: string,
    events: ConnectorEvent[]
  ): Promise<void> {
    for (const event of events) {
      if (event.kind === 'snapshot') {
        // Not working never means done: an open turn the snapshot doesn't show working (or doesn't
        // list; it lists every linked conversation) is unverifiable.
        const working = event.conversations
          .filter((entry) => entry.working)
          .map((entry) => entry.conversation.externalId)
        await transaction.query(
          `UPDATE connector_threads SET turn_state = 'unverifiable'
           WHERE host_id = ? AND turn_state = 'working'${
             working.length > 0 ? ` AND external_id NOT IN (${working.map(() => '?').join(', ')})` : ''
           }`,
          [hostId, ...working]
        )
        for (const entry of event.conversations) {
          await transaction.query(
            `UPDATE connector_threads SET pane_key = ?, agent = ?, pending_prompt = ?
             WHERE host_id = ? AND external_id = ?`,
            [
              entry.paneKey,
              entry.agent,
              entry.prompt ? JSON.stringify(entry.prompt) : null,
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
  }
}
