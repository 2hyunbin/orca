import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'

// message: chat.postMessage; status: posted once, then edited in place; reaction: reactions.add.
export type SlackPostKind = 'message' | 'status' | 'reaction'

export type SlackPlace = { teamId: string; channelId: string; threadTs: string }

export type ClaimedPost = SlackPlace & {
  postId: string
  kind: SlackPostKind
  body: Record<string, unknown>
  rev: number
  attempts: number
  slackTs: string | null
  // Claimed back from a sender that never finished: it may already be in Slack.
  stale: boolean
  sentAt: number
}

const CLAIM_BATCH = 20
// A post still sending after this was abandoned (crash or a lost reply) and is checked again.
const SENDING_LEASE_MS = 60_000
const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000

// States: queued -> sending -> posted, or failed / uncertain / cancelled. Posts in one channel go
// one at a time, in queue order.
export class SlackPosts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly now: () => number
  ) {}

  // Idempotent by post id: a retried caller queues nothing new.
  async queue(
    transaction: CloudDatabase,
    post: SlackPlace & {
      postId: string
      kind: Exclude<SlackPostKind, 'status'>
      body: Record<string, unknown>
      turnKey?: string
      delayMs?: number
    }
  ): Promise<void> {
    const now = this.now()
    await transaction.query(
      `INSERT INTO connector_slack_posts
       (post_id, team_id, channel_id, thread_ts, kind, body, turn_key, rev, state, attempts,
        next_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'queued', 0, ?, ?) ON CONFLICT (post_id) DO NOTHING`,
      [
        post.postId,
        post.teamId,
        post.channelId,
        post.threadTs,
        post.kind,
        JSON.stringify(post.body),
        post.turnKey ?? null,
        now + (post.delayMs ?? 0),
        now
      ]
    )
  }

  // A changed text bumps rev; a sender holding an older rev leaves the row queued for one more edit.
  async setStatus(
    transaction: CloudDatabase,
    status: SlackPlace & { postId: string; text: string }
  ): Promise<void> {
    const now = this.now()
    await transaction.query(
      `INSERT INTO connector_slack_posts
       (post_id, team_id, channel_id, thread_ts, kind, body, rev, state, attempts, next_at,
        updated_at)
       VALUES (?, ?, ?, ?, 'status', ?, 0, 'queued', 0, ?, ?)
       ON CONFLICT (post_id) DO UPDATE SET body = excluded.body,
         rev = connector_slack_posts.rev + 1, attempts = 0,
         state = CASE WHEN connector_slack_posts.state = 'sending' THEN 'sending' ELSE 'queued' END,
         next_at = CASE WHEN connector_slack_posts.state = 'sending'
           THEN connector_slack_posts.next_at ELSE excluded.next_at END
       WHERE connector_slack_posts.body <> excluded.body`,
      [
        status.postId,
        status.teamId,
        status.channelId,
        status.threadTs,
        JSON.stringify({ text: status.text }),
        now,
        now
      ]
    )
  }

  async hasReplyForTurn(transaction: CloudDatabase, turnKey: string): Promise<boolean> {
    const [row] = await transaction.query(
      `SELECT 1 AS found FROM connector_slack_posts
       WHERE turn_key = ? AND post_id LIKE 'reply:%' LIMIT 1`,
      [turnKey]
    )
    return row !== undefined
  }

  // A reply in a turn makes its fallback post unnecessary, if that hasn't gone out yet.
  async cancelQueued(transaction: CloudDatabase, postId: string): Promise<void> {
    await transaction.query(
      `UPDATE connector_slack_posts SET state = 'cancelled', updated_at = ?
       WHERE post_id = ? AND state = 'queued'`,
      [this.now(), postId]
    )
  }

  async find(
    transaction: CloudDatabase,
    postId: string
  ): Promise<{ state: string; slackTs: string | null } | null> {
    const [row] = await transaction.query(
      'SELECT state, slack_ts FROM connector_slack_posts WHERE post_id = ?',
      [postId]
    )
    return row ? { state: String(row.state), slackTs: nullableText(row.slack_ts) } : null
  }

  // One claimer at a time across instances, so "no post sending in this channel" holds once it commits.
  async claim(): Promise<ClaimedPost[]> {
    return await this.database.transaction(async (transaction) => {
      if (!(await transaction.tryLockScope('orca-connector-slack-posts-claim'))) {
        return []
      }
      const now = this.now()
      const rows = await transaction.query(
        `SELECT * FROM connector_slack_posts p
         WHERE p.state IN ('queued', 'sending') AND p.next_at <= ?
           AND NOT EXISTS (SELECT 1 FROM connector_slack_posts busy
             WHERE busy.channel_id = p.channel_id AND busy.state = 'sending' AND busy.next_at > ?)
         ORDER BY p.next_at, p.post_id LIMIT ?`,
        [now, now, CLAIM_BATCH]
      )
      const channels = new Set<string>()
      const claimed: ClaimedPost[] = []
      for (const row of rows) {
        const channelId = String(row.channel_id)
        if (channels.has(channelId)) {
          continue
        }
        channels.add(channelId)
        const stale = row.state === 'sending'
        await transaction.query(
          `UPDATE connector_slack_posts SET state = 'sending', attempts = attempts + 1,
             next_at = ?, updated_at = ?
           WHERE post_id = ?`,
          [now + SENDING_LEASE_MS, stale ? Number(row.updated_at) : now, row.post_id]
        )
        claimed.push(claimedPost(row, stale, stale ? Number(row.updated_at) : now))
      }
      return claimed
    })
  }

  async posted(post: ClaimedPost, slackTs?: string): Promise<void> {
    await this.database.query(
      `UPDATE connector_slack_posts
       SET state = CASE WHEN rev = ? THEN 'posted' ELSE 'queued' END, attempts = 0,
         slack_ts = COALESCE(?, slack_ts), next_at = ?, updated_at = ?
       WHERE post_id = ? AND state = 'sending'`,
      [post.rev, slackTs ?? null, this.now(), this.now(), post.postId]
    )
  }

  // Slack said not now: every queued post in the channel waits, as its rate limit is per channel.
  async retry(post: ClaimedPost, afterMs?: number): Promise<void> {
    if (post.attempts >= MAX_ATTEMPTS) {
      await this.settle(post, 'failed')
      return
    }
    const now = this.now()
    const nextAt =
      now + (afterMs ?? Math.min(RETRY_BASE_MS * 2 ** (post.attempts - 1), RETRY_MAX_MS))
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE connector_slack_posts SET state = 'queued', next_at = ?, updated_at = ?
         WHERE post_id = ? AND state = 'sending'`,
        [nextAt, now, post.postId]
      )
      if (afterMs !== undefined) {
        await transaction.query(
          `UPDATE connector_slack_posts SET next_at = ?
           WHERE channel_id = ? AND state = 'queued' AND next_at < ?`,
          [nextAt, post.channelId, nextAt]
        )
      }
    })
  }

  // failed: Slack refused it. uncertain: it may have posted and we couldn't check, so no retry.
  async settle(post: ClaimedPost, state: 'failed' | 'uncertain'): Promise<void> {
    await this.database.query(
      `UPDATE connector_slack_posts SET state = ?, updated_at = ?
       WHERE post_id = ? AND state = 'sending'`,
      [state, this.now(), post.postId]
    )
  }

  // Status rows stay while their thread may still be edited; finished one-off posts go after a day.
  async pruneFinished(retentionMs: number): Promise<number> {
    const [result] = await this.database.query(
      `DELETE FROM connector_slack_posts
       WHERE kind <> 'status' AND state IN ('posted', 'failed', 'uncertain', 'cancelled')
         AND updated_at < ?`,
      [this.now() - retentionMs]
    )
    return Number(result?.changes ?? 0)
  }
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function claimedPost(row: SqlRow, stale: boolean, sentAt: number): ClaimedPost {
  const kind = String(row.kind)
  if (kind !== 'message' && kind !== 'status' && kind !== 'reaction') {
    throw new Error('unknown Slack post kind')
  }
  const body: unknown = JSON.parse(String(row.body))
  if (typeof body !== 'object' || body === null) {
    throw new Error('unreadable Slack post body')
  }
  return {
    postId: String(row.post_id),
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    kind,
    body: Object.fromEntries(Object.entries(body)),
    rev: Number(row.rev),
    attempts: Number(row.attempts) + 1,
    slackTs: nullableText(row.slack_ts),
    stale,
    sentAt
  }
}
