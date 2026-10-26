import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import { CONNECTOR_LIMITS } from '@orca-cloud/connector-contract'
import { z } from 'zod'
import { PERSON_SUBTYPES, promptText } from './slack-events.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackMembers } from './slack-members.js'
import type { SlackPosts } from './slack-posts.js'
import type { QueueInTransaction } from './slack-routing.js'
import { withTeammateContext } from './slack-teammate-context.js'
import { slackText } from './slack-text.js'
import { refreshSlackStatus } from './slack-thread-posts.js'
import type { SlackWebApi } from './slack-web-api.js'

const STARTS_PER_PASS = 10
// Bounds on the thread a start carries: the first message plus the latest ones, each capped, read
// over at most a few pages; a longer thread starts with the "couldn't be read" note instead.
const THREAD_PAGE_SIZE = 200
const THREAD_MAX_PAGES = 5
const THREAD_MAX_MESSAGES = 20
const THREAD_MAX_MESSAGE_CHARS = 2_000

const RepliesSchema = z.object({
  messages: z.array(
    z.looseObject({
      ts: z.string(),
      user: z.string().optional(),
      bot_id: z.string().optional(),
      subtype: z.string().optional(),
      text: z.string().default('')
    })
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional()
})
type ThreadMessage = z.infer<typeof RepliesSchema>['messages'][number]

type HeldStart = {
  messageKey: string
  teamId: string
  channelId: string
  threadTs: string
  ts: string
}

// Builds starts for mentions partway through a thread (decisions §6: the request plus the thread
// start, labelled). Ingress only holds them; this reads the thread off the request path, then queues
// the start and any follow-ups held behind it.
export class SlackThreadStarts {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      installs: SlackInstalls
      members: SlackMembers
      posts: SlackPosts
      queue: QueueInTransaction
      api: SlackWebApi
      now: () => number
    }
  ) {}

  async buildDue(): Promise<void> {
    const conversations = await this.deps.database.query(
      `SELECT external_id FROM connector_slack_pending
       GROUP BY external_id ORDER BY MIN(received_at) LIMIT ?`,
      [STARTS_PER_PASS]
    )
    for (const row of conversations) {
      const externalId = String(row.external_id)
      const [first] = this.unexpired(await heldMessages(this.deps.database, externalId))
      const start = first ? heldStart(first) : null
      await this.release(externalId, start, start ? await this.threadBefore(start) : null)
    }
  }

  // Held messages still inside their 5 minutes, against one clock reading. The first is the start:
  // derived at release, not fixed on arrival, so a start that expired while the worker lagged hands
  // over to the next one.
  private unexpired(held: SqlRow[]): SqlRow[] {
    const cutoff = this.deps.now()
    return held.filter(
      (message) => Number(message.received_at) + CONNECTOR_LIMITS.deliveryTtlMs > cutoff
    )
  }

  // The thread's earlier messages from full members, labelled; null when Slack couldn't be read.
  private async threadBefore(start: HeldStart): Promise<{ name: string; text: string }[] | null> {
    const { database, installs, api } = this.deps
    const install = await installs.find(database, start.teamId)
    const token = await installs.botToken(database, start.teamId)
    if (!install || token === null) {
      return null
    }
    let first: ThreadMessage | undefined
    let latest: ThreadMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = await api(token, 'conversations.replies', {
        channel: start.channelId,
        ts: start.threadTs,
        latest: start.ts,
        inclusive: false,
        limit: THREAD_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor })
      })
      const replies = result.kind === 'ok' ? RepliesSchema.safeParse(result.body) : undefined
      if (!replies?.success) {
        return null
      }
      const people = replies.data.messages.filter(
        (message) =>
          message.ts !== start.ts &&
          message.user !== undefined &&
          message.bot_id === undefined &&
          (message.subtype === undefined || PERSON_SUBTYPES.has(message.subtype))
      )
      first ??= people.shift()
      latest = [...latest, ...people].slice(-(THREAD_MAX_MESSAGES - 1))
      // next_cursor continues; "more" without one can't be read to the end.
      cursor = replies.data.response_metadata?.next_cursor || undefined
      if (cursor === undefined) {
        return replies.data.has_more
          ? null
          : await this.labelled(start.teamId, install.botUserId, first ? [first, ...latest] : [])
      }
    }
    return null
  }

  // Each kept message under its author's name; authors not confirmed full members are left out.
  private async labelled(
    teamId: string,
    botUserId: string,
    kept: ThreadMessage[]
  ): Promise<{ name: string; text: string }[]> {
    const names = await this.deps.members.memberNames(
      teamId,
      kept.flatMap((message) => message.user ?? [])
    )
    return kept.flatMap((message) => {
      const name = message.user === undefined ? undefined : names.get(message.user)
      const text = promptText(message.text, botUserId).slice(0, THREAD_MAX_MESSAGE_CHARS)
      return name === undefined || text.length === 0 ? [] : [{ name, text }]
    })
  }

  // Queues the start, then every later unexpired held message as a follow-up, in one transaction
  // under the Slack thread's routing lock; expired ones are dropped. If what was read before taking the lock
  // no longer names the same start, the next pass does it.
  private async release(
    externalId: string,
    start: HeldStart | null,
    thread: { name: string; text: string }[] | null
  ): Promise<void> {
    const { database, posts, queue, now } = this.deps
    await database.transaction(async (transaction) => {
      const [first] = await heldMessages(transaction, externalId)
      if (!first) {
        return
      }
      await transaction.lockQuotaScope(
        `orca-connector-slack-thread:${String(first.team_id)}:${String(first.channel_id)}:${String(first.thread_ts)}`
      )
      const live = this.unexpired(await heldMessages(transaction, externalId))
      if ((live[0] === undefined ? undefined : String(live[0].message_key)) !== start?.messageKey) {
        return
      }
      for (const [index, row] of live.entries()) {
        const request = String(row.text)
        await queue(transaction, {
          thread: {
            externalId,
            teamId: String(row.team_id),
            channelId: String(row.channel_id),
            threadTs: String(row.thread_ts),
            ownerUserId: String(row.owner_user_id),
            hostId: String(row.host_id),
            placeId: String(row.place_id)
          },
          deliveryId: String(row.message_key),
          receivedAt: Number(row.received_at),
          body:
            index === 0
              ? {
                  kind: 'start',
                  agent: String(row.agent),
                  placeId: String(row.place_id),
                  prompt: slackText.threadStart(thread, request)
                }
              : {
                  kind: 'send',
                  text: await withTeammateContext(transaction, externalId, request, now())
                }
        })
      }
      await transaction.query('DELETE FROM connector_slack_pending WHERE external_id = ?', [
        externalId
      ])
      if (live.length > 0) {
        await refreshSlackStatus(transaction, posts, String(first.host_id), externalId)
      }
    })
  }
}

function heldStart(row: SqlRow): HeldStart {
  return {
    messageKey: String(row.message_key),
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    ts: String(row.ts)
  }
}

// A conversation's held messages in Slack order (message ts), not by any instance's clock.
async function heldMessages(database: CloudDatabase, externalId: string): Promise<SqlRow[]> {
  return await database.query(
    'SELECT * FROM connector_slack_pending WHERE external_id = ? ORDER BY ts, message_key',
    [externalId]
  )
}
