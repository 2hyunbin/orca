import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_PATHS,
  ConnectorReplyRequestSchema,
  type ConnectorEvent,
  type ConnectorReplyResponse
} from '@orca-cloud/connector-contract'
import type { Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { every } from './connector-background.js'
import type { MachineEnv } from './machine-auth.js'
import type { SlackConfig } from './slack-config.js'
import { readSlackEnvelope } from './slack-events.js'
import { SlackInstalls } from './slack-installs.js'
import { SlackPostWorker } from './slack-post-worker.js'
import { SlackPosts } from './slack-posts.js'
import { routeSlackMessage, type QueueInTransaction } from './slack-routing.js'
import { verifySlackSignature } from './slack-signature.js'
import { escapeSlackText } from './slack-text.js'
import { refreshSlackThread } from './slack-thread-status.js'
import { createSlackWebApi, type SlackWebApi } from './slack-web-api.js'

// Slack's payloads can carry blocks and files well past the machine API's limit.
const MAX_SLACK_BODY_BYTES = 1024 * 1024
const POST_INTERVAL_MS = 1_000
const MEMBER_CHECK_INTERVAL_MS = 5_000
const RETENTION_INTERVAL_MS = 60_000
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60_000
const CONTEXT_RETENTION_MS = 24 * 60 * 60_000
const POST_RETENTION_MS = 24 * 60 * 60_000

export type SlackEdge = ReturnType<typeof createSlackEdge>

// Slack in and out: event ingress, the agent's replies, and the post queue that turns thread state
// into a reaction, one edited status message and the offline / fallback posts.
export function createSlackEdge(deps: {
  config: SlackConfig
  database: CloudDatabase
  queue: QueueInTransaction
  now: () => number
  api?: SlackWebApi
}) {
  const { config, database, now } = deps
  const installs = new SlackInstalls(config.tokenKey)
  const posts = new SlackPosts(database, now)
  const worker = new SlackPostWorker({
    database,
    posts,
    installs,
    api: deps.api ?? createSlackWebApi(),
    now
  })
  const refresh = async (transaction: CloudDatabase, externalIds: Iterable<string>) => {
    for (const externalId of new Set(externalIds)) {
      await refreshSlackThread(transaction, posts, externalId)
    }
  }

  function registerRoutes(app: Hono<MachineEnv>, limitMachineBody: MiddlewareHandler): void {
    app.post(
      '/slack/events',
      bodyLimit({
        maxSize: MAX_SLACK_BODY_BYTES,
        onError: (context) => context.json({ error: 'request_too_large' }, 413)
      }),
      async (context) => {
        const rawBody = await context.req.text()
        const verified = verifySlackSignature({
          signingSecret: config.signingSecret,
          timestamp: context.req.header('x-slack-request-timestamp'),
          signature: context.req.header('x-slack-signature'),
          rawBody,
          nowMs: now()
        })
        if (!verified) {
          return context.json({ error: 'invalid_signature' }, 401)
        }
        let payload: unknown
        try {
          payload = JSON.parse(rawBody)
        } catch {
          return context.json({ error: 'invalid_request' }, 400)
        }
        const envelope = readSlackEnvelope(payload)
        if (envelope.kind === 'invalid') {
          return context.json({ error: 'invalid_request' }, 400)
        }
        if (envelope.kind === 'url_verification') {
          return context.json({ challenge: envelope.challenge })
        }
        // Answered before any Slack call; a database failure is a 500, so Slack retries.
        if (envelope.kind === 'message' && config.teamIds.has(envelope.message.teamId)) {
          await routeSlackMessage(
            { config, database, installs, posts, queue: deps.queue, now },
            envelope.message
          )
          worker.wake()
        }
        return context.body(null, 200)
      }
    )

    app.post(CONNECTOR_PATHS.replies, limitMachineBody, async (context) => {
      const body = ConnectorReplyRequestSchema.safeParse(await context.req.json().catch(() => null))
      if (!body.success) {
        return context.json({ error: 'invalid_request' }, 400)
      }
      const { hostId } = context.get('host')
      const { replyId, conversation, turnId, text } = body.data
      const sent = await database.transaction(async (transaction) => {
        const [thread] = await transaction.query(
          `SELECT team_id, channel_id, thread_ts FROM connector_threads
           WHERE external_id = ? AND host_id = ?`,
          [conversation.externalId, hostId]
        )
        if (!thread) {
          return null
        }
        const postId = `reply:${hostId}:${replyId}`
        const turnKey = `${conversation.externalId}:${turnId}`
        await posts.queue(transaction, {
          teamId: String(thread.team_id),
          channelId: String(thread.channel_id),
          threadTs: String(thread.thread_ts),
          postId,
          kind: 'message',
          body: { text: escapeSlackText(text) },
          turnKey
        })
        await posts.cancelQueued(transaction, `fallback:${turnKey}`)
        return await posts.find(transaction, postId)
      })
      if (!sent) {
        return context.json({ error: 'not_this_hosts_thread' }, 403)
      }
      worker.wake()
      const response: ConnectorReplyResponse =
        sent.state === 'posted' && sent.slackTs !== null
          ? { status: 'posted', messageTs: sent.slackTs }
          : { status: 'queued' }
      return context.json(response)
    })
  }

  return {
    registerRoutes,
    worker,
    // In the transaction that applied a machine's events batch; posts go out on the next pass.
    onEvents: async (transaction: CloudDatabase, hostId: string, events: ConnectorEvent[]) => {
      const externalIds = events.flatMap((event) =>
        event.kind === 'snapshot'
          ? event.conversations.map((entry) => entry.conversation.externalId)
          : [event.conversation.externalId]
      )
      // A snapshot can mark threads it doesn't list unverifiable.
      const unverifiable = events.some((event) => event.kind === 'snapshot')
        ? await transaction.query(
            `SELECT external_id FROM connector_threads
             WHERE host_id = ? AND turn_state = 'unverifiable'`,
            [hostId]
          )
        : []
      await refresh(transaction, [
        ...externalIds,
        ...unverifiable.map((row) => String(row.external_id))
      ])
    },
    // In the transaction that recorded a machine's confirmations.
    onAcks: async (transaction: CloudDatabase, hostId: string, deliveryIds: string[]) => {
      const rows = await transaction.query(
        `SELECT DISTINCT external_id FROM connector_inbox
         WHERE host_id = ? AND delivery_id IN (${deliveryIds.map(() => '?').join(', ')})`,
        [hostId, ...deliveryIds]
      )
      await refresh(
        transaction,
        rows.map((row) => String(row.external_id))
      )
    },
    // After the expiry sweep, with the threads it hit.
    onExpired: async (threads: { externalId: string }[]) => {
      await database.transaction((transaction) =>
        refresh(
          transaction,
          threads.map((thread) => thread.externalId)
        )
      )
    },
    startBackground: (): (() => void) => {
      worker.start()
      const stops = [
        () => worker.stop(),
        every('slack_posts', POST_INTERVAL_MS, () => worker.sendDue()),
        every('slack_members', MEMBER_CHECK_INTERVAL_MS, () => worker.checkMembers()),
        every('slack_retention', RETENTION_INTERVAL_MS, async () => {
          await database.query('DELETE FROM connector_slack_seen WHERE seen_at < ?', [
            now() - SEEN_RETENTION_MS
          ])
          await database.query('DELETE FROM connector_thread_context WHERE created_at < ?', [
            now() - CONTEXT_RETENTION_MS
          ])
          await posts.pruneFinished(POST_RETENTION_MS)
        })
      ]
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    }
  }
}
