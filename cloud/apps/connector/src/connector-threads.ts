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

  // A mark matters only while its connection lives (a session lasts an hour); this bounds the rest.
  async pruneEventMarks(database: CloudDatabase, olderThanMs: number): Promise<number> {
    const [result] = await database.query(
      'DELETE FROM connector_event_marks WHERE updated_at < ?',
      [this.now() - olderThanMs]
    )
    return Number(result?.changes ?? 0)
  }

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
  // A batch applies only above its connection's high-water mark: a late original or a retry of an
  // applied batch changes nothing. False means it was dropped as stale.
  async applyEvents(
    transaction: CloudDatabase,
    connection: { hostId: string; connectionId: string },
    seq: number,
    events: ConnectorEvent[]
  ): Promise<boolean> {
    const { hostId } = connection
    const [advanced] = await transaction.query(
      `INSERT INTO connector_event_marks (connection_id, seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
       WHERE connector_event_marks.seq < excluded.seq`,
      [connection.connectionId, seq, this.now()]
    )
    if (Number(advanced?.changes ?? 0) === 0) {
      return false
    }
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
    return true
  }
}
