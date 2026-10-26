import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import { promptText } from './slack-events.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackMembers } from './slack-members.js'
import type { SlackPosts } from './slack-posts.js'
import type { QueueInTransaction } from './slack-routing.js'
import { slackText } from './slack-text.js'
import { refreshSlackStatus } from './slack-thread-posts.js'
import type { SlackWebApi } from './slack-web-api.js'

const STARTS_PER_PASS = 10
// Bounds on the thread a start carries: the first message plus the latest ones, each capped.
const THREAD_FETCH_LIMIT = 100
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
  )
})

type HeldStart = {
  messageKey: string
  externalId: string
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
    }
  ) {}

  async buildDue(): Promise<void> {
    const rows = await this.deps.database.query(
      `SELECT message_key, external_id, team_id, channel_id, thread_ts, ts
       FROM connector_slack_pending WHERE kind = 'start' ORDER BY received_at LIMIT ?`,
      [STARTS_PER_PASS]
    )
    for (const row of rows) {
      const start: HeldStart = {
        messageKey: String(row.message_key),
        externalId: String(row.external_id),
        teamId: String(row.team_id),
        channelId: String(row.channel_id),
        threadTs: String(row.thread_ts),
        ts: String(row.ts)
      }
      await this.release(start, await this.threadBefore(start))
    }
  }

  // The thread's earlier messages from full members, labelled; null when Slack couldn't be read.
  private async threadBefore(start: HeldStart): Promise<{ name: string; text: string }[] | null> {
    const { database, installs, members, api } = this.deps
    const install = await installs.find(database, start.teamId)
    const token = await installs.botToken(database, start.teamId)
    if (!install || token === null) {
      return null
    }
    const result = await api(token, 'conversations.replies', {
      channel: start.channelId,
      ts: start.threadTs,
      latest: start.ts,
      inclusive: false,
      limit: THREAD_FETCH_LIMIT
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
        message.subtype === undefined
    )
    const [first, ...rest] = people
    const kept = first ? [first, ...rest.slice(-(THREAD_MAX_MESSAGES - 1))] : []
    const names = await members.memberNames(
      start.teamId,
      kept.flatMap((message) => message.user ?? [])
    )
    return kept.flatMap((message) => {
      const name = message.user === undefined ? undefined : names.get(message.user)
      const text = promptText(message.text, install.botUserId).slice(0, THREAD_MAX_MESSAGE_CHARS)
      return name === undefined || text.length === 0 ? [] : [{ name, text }]
    })
  }

  // Queues the start, then every follow-up held behind it, in one transaction under the Slack
  // thread's routing lock; another instance that got here first leaves nothing to do.
  private async release(
    start: HeldStart,
    thread: { name: string; text: string }[] | null
  ): Promise<void> {
    const { database, posts, queue } = this.deps
    await database.transaction(async (transaction) => {
      await transaction.lockQuotaScope(
        `orca-connector-slack-thread:${start.teamId}:${start.channelId}:${start.threadTs}`
      )
      const held = await transaction.query(
        `SELECT * FROM connector_slack_pending WHERE external_id = ?
         ORDER BY received_at, message_key`,
        [start.externalId]
      )
      const head = held[0]
      if (head?.message_key !== start.messageKey) {
        return
      }
      for (const row of held) {
        const request = String(row.text)
        await queue(transaction, {
          thread: {
            externalId: start.externalId,
            teamId: start.teamId,
            channelId: start.channelId,
            threadTs: start.threadTs,
            ownerUserId: String(row.owner_user_id),
            hostId: String(row.host_id),
            placeId: String(row.place_id)
          },
          deliveryId: String(row.message_key),
          receivedAt: Number(row.received_at),
          body:
            row.kind === 'start'
              ? {
                  kind: 'start',
                  agent: String(row.agent),
                  placeId: String(row.place_id),
                  prompt: slackText.threadStart(thread, request)
                }
              : { kind: 'send', text: request }
        })
      }
      await transaction.query('DELETE FROM connector_slack_pending WHERE external_id = ?', [
        start.externalId
      ])
      await refreshSlackStatus(transaction, posts, String(head.host_id), start.externalId)
    })
  }
}
