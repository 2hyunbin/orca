import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import { MEMBERSHIP_TTL_MS, membershipOf } from './slack-identities.js'
import type { SlackInstalls } from './slack-installs.js'
import type { ClaimedPost, SlackPosts } from './slack-posts.js'
import type { SlackResult, SlackWebApi } from './slack-web-api.js'

const TextBodySchema = z.object({ text: z.string().min(1) })
const ReactionBodySchema = z.object({ name: z.string().min(1), timestamp: z.string().min(1) })
const RepliesSchema = z.object({
  messages: z.array(
    z.looseObject({
      ts: z.string(),
      metadata: z.object({ event_payload: z.looseObject({ post_id: z.unknown() }) }).optional()
    })
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional()
})
// Slack may send absent, null or empty profile names; none of that bears on membership.
const UserInfoSchema = z.object({ user: z.looseObject({}) })
const UserNamesSchema = z.object({
  profile: z
    .looseObject({ display_name: z.string().nullish(), real_name: z.string().nullish() })
    .nullish(),
  name: z.string().nullish()
})
const POST_METADATA_TYPE = 'orca_post'
const MEMBER_CHECKS_PER_PASS = 20
// A post claimed back after a crash is looked for among replies sent from shortly before it, over
// a bounded number of pages; past that it can't be ruled out, so it is uncertain.
const RECONCILE_LOOKBACK_MS = 60_000
const RECONCILE_MAX_PAGES = 3

// Sends queued posts. A new message carries its post id in Slack metadata, so one that was left
// mid-send is looked for in the thread before it is sent again; if that check can't run, the post
// is marked uncertain rather than risking a duplicate.
export class SlackPostWorker {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      posts: SlackPosts
      installs: SlackInstalls
      api: SlackWebApi
      now: () => number
    }
  ) {}

  // Claimed heads are in different channels and go out in parallel, well inside their lease. A
  // database error leaves its post sending, so the lease brings it back to the history check.
  async sendDue(): Promise<void> {
    const claimed = await this.deps.posts.claim()
    const sent = await Promise.allSettled(claimed.map((post) => this.sendClaimed(post)))
    const failure = sent.find((result) => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  }

  // A post that can never go (no readable install token, an unreadable body) fails rather than
  // holding its channel.
  private async sendClaimed(post: ClaimedPost): Promise<void> {
    const token = await this.deps.installs.botToken(this.deps.database, post.teamId)
    const body = (post.kind === 'reaction' ? ReactionBodySchema : TextBodySchema).safeParse(
      post.body
    )
    if (token === null || !body.success) {
      await this.deps.posts.settle(post, 'failed')
      return
    }
    await this.send(token, post)
  }

  private async send(token: string, post: ClaimedPost): Promise<void> {
    const { api, posts } = this.deps
    if (post.kind === 'reaction') {
      const body = ReactionBodySchema.parse(post.body)
      const result = await api(token, 'reactions.add', { channel: post.channelId, ...body })
      await this.finish(
        post,
        result.kind === 'failed' && result.error === 'already_reacted'
          ? { kind: 'ok', body: {} }
          : result,
        'retry'
      )
      return
    }
    const { text } = TextBodySchema.parse(post.body)
    if (post.kind === 'status' && post.slackTs !== null) {
      const result = await api(token, 'chat.update', {
        channel: post.channelId,
        ts: post.slackTs,
        text
      })
      await this.finish(post, result, 'retry')
      return
    }
    if (post.stale) {
      const found = await this.findSent(token, post)
      if (found === undefined) {
        if (await posts.settle(post, 'uncertain')) {
          console.warn(JSON.stringify({ event: 'orca_connector_slack_post_uncertain' }))
        }
        return
      }
      if (found !== null) {
        await posts.found(post, found)
        return
      }
    }
    const result = await api(token, 'chat.postMessage', {
      channel: post.channelId,
      thread_ts: post.threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
      metadata: { event_type: POST_METADATA_TYPE, event_payload: { post_id: post.postId } }
    })
    // An unknown outcome stays sending; the lease brings it back to findSent.
    await this.finish(post, result, 'leave')
  }

  private async finish(
    post: ClaimedPost,
    result: SlackResult,
    onUnknown: 'retry' | 'leave'
  ): Promise<void> {
    const { posts } = this.deps
    switch (result.kind) {
      case 'ok': {
        const ts = typeof result.body.ts === 'string' ? result.body.ts : undefined
        await posts.posted(post, ts)
        return
      }
      case 'failed':
        await posts.settle(post, 'failed')
        return
      case 'retry':
        await posts.retry(post, result.afterMs)
        return
      case 'unknown':
        if (onUnknown === 'retry') {
          await posts.retry(post)
        }
    }
  }

  // The sent message's ts, null when it isn't in the thread, undefined when we couldn't tell.
  private async findSent(token: string, post: ClaimedPost): Promise<string | null | undefined> {
    let cursor: string | undefined
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const result = await this.deps.api(token, 'conversations.replies', {
        channel: post.channelId,
        ts: post.threadTs,
        oldest: String((post.sentAt - RECONCILE_LOOKBACK_MS) / 1000),
        include_all_metadata: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor })
      })
      const replies = result.kind === 'ok' ? RepliesSchema.safeParse(result.body) : undefined
      if (!replies?.success) {
        return undefined
      }
      const sent = replies.data.messages.find(
        (message) => message.metadata?.event_payload.post_id === post.postId
      )
      if (sent) {
        return sent.ts
      }
      // next_cursor is Slack's continuation; "more" without one can't be searched to the end.
      cursor = replies.data.response_metadata?.next_cursor || undefined
      if (cursor === undefined) {
        return replies.data.has_more ? undefined : null
      }
    }
    return undefined
  }

  // Fills the membership cache for teammates whose messages wait as context (decisions §1).
  async checkMembers(): Promise<void> {
    const { database, installs, api, now } = this.deps
    const authors = await database.query(
      `SELECT DISTINCT c.team_id, c.author_user_id FROM connector_thread_context c
       LEFT JOIN connector_slack_users u
         ON u.team_id = c.team_id AND u.slack_user_id = c.author_user_id
       WHERE u.slack_user_id IS NULL OR u.checked_at < ? LIMIT ?`,
      [now() - MEMBERSHIP_TTL_MS, MEMBER_CHECKS_PER_PASS]
    )
    for (const author of authors) {
      const teamId = String(author.team_id)
      const userId = String(author.author_user_id)
      const token = await installs.botToken(database, teamId)
      const result = token === null ? null : await api(token, 'users.info', { user: userId })
      if (result?.kind !== 'ok' && result?.kind !== 'failed') {
        continue
      }
      const info = result.kind === 'ok' ? UserInfoSchema.safeParse(result.body) : undefined
      const user = info?.success ? info.data.user : undefined
      const names = UserNamesSchema.safeParse(user).data
      const name =
        names?.profile?.display_name || names?.profile?.real_name || names?.name || userId
      await database.query(
        `INSERT INTO connector_slack_users (team_id, slack_user_id, membership, display_name, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (team_id, slack_user_id) DO UPDATE SET membership = excluded.membership,
           display_name = excluded.display_name, checked_at = excluded.checked_at`,
        [teamId, userId, user ? membershipOf(user, teamId) : 'other', name, now()]
      )
    }
  }
}
