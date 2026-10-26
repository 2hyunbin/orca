import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_AGENTS,
  ConnectorDeliveryResultSchema,
  ConnectorHelloRequestSchema
} from '@orca-cloud/connector-contract'
import type { DeliveryBody } from './connector-inbox.js'
import type { QueueResult } from './queue-delivery.js'
import type { SlackConfig } from './slack-config.js'
import { mentionsBot, promptText, type SlackMessage } from './slack-events.js'
import { findSlackIdentity } from './slack-identities.js'
import type { SlackInstall, SlackInstalls } from './slack-installs.js'
import { chooseMachine, type KnownHost } from './slack-machine-choice.js'
import type { SlackPlace, SlackPosts } from './slack-posts.js'
import { slackText } from './slack-text.js'
import { refreshSlackThread } from './slack-thread-status.js'

export type QueueInTransaction = (
  transaction: CloudDatabase,
  input: {
    thread: {
      externalId: string
      teamId: string
      channelId: string
      threadTs: string
      ownerUserId: string
      hostId: string
      placeId: string
    }
    deliveryId: string
    body: DeliveryBody
  }
) => Promise<QueueResult>

export type SlackRoutingDeps = {
  config: SlackConfig
  database: CloudDatabase
  installs: SlackInstalls
  posts: SlackPosts
  queue: QueueInTransaction
  now: () => number
}

type ThreadRow = {
  externalId: string
  ownerUserId: string
  hostId: string
  placeId: string
  paneKey: string | null
}

// Decisions §1: only a conversation's owner starts or steers it; anyone else's message in the thread
// is kept as context for the owner's next turn, and a new mention by them starts their own.
export async function routeSlackMessage(
  deps: SlackRoutingDeps,
  message: SlackMessage
): Promise<void> {
  const { teamId, channelId, threadTs, ts, userId } = message
  const messageKey = `${teamId}:${channelId}:${ts}`
  await deps.database.transaction(async (transaction) => {
    // Slack sends message and app_mention for one post, and retries both.
    const [seen] = await transaction.query(
      `INSERT INTO connector_slack_seen (message_key, seen_at) VALUES (?, ?)
       ON CONFLICT (message_key) DO NOTHING`,
      [messageKey, deps.now()]
    )
    if (Number(seen?.changes ?? 0) === 0) {
      return
    }
    const install = await deps.installs.find(transaction, teamId)
    if (!install || userId === install.botUserId) {
      return
    }
    // Serializes routing per Slack thread, so two quick messages can't both start a conversation.
    await transaction.lockQuotaScope(
      `orca-connector-slack-thread:${teamId}:${channelId}:${threadTs}`
    )
    const threads = await threadsIn(transaction, { teamId, channelId, threadTs })
    const own = threads.find((thread) => thread.ownerUserId === userId)
    if (!own && !message.direct && !mentionsBot(message.text, install.botUserId)) {
      for (const thread of threads) {
        await transaction.query(
          `INSERT INTO connector_thread_context
           (external_id, ts, team_id, author_user_id, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (external_id, ts) DO NOTHING`,
          [
            thread.externalId,
            ts,
            teamId,
            userId,
            promptText(message.text, install.botUserId),
            deps.now()
          ]
        )
      }
      return
    }
    const place = { teamId, channelId, threadTs }
    if (deps.config.paused || install.paused) {
      await reply(
        deps,
        transaction,
        place,
        `paused:${teamId}:${channelId}:${threadTs}`,
        slackText.paused
      )
      return
    }
    const text = promptText(message.text, install.botUserId)
    if (text.length === 0) {
      return
    }
    const route = { deps, transaction, message, messageKey, place, install, text }
    await (own ? continueConversation(route, own) : startConversation(route))
  })
}

type Route = {
  deps: SlackRoutingDeps
  transaction: CloudDatabase
  message: SlackMessage
  messageKey: string
  place: SlackPlace
  install: SlackInstall
  text: string
}

async function startConversation(route: Route): Promise<void> {
  const { deps, transaction, message, messageKey, place } = route
  const identity = await findSlackIdentity(transaction, message.teamId, message.userId)
  if (!identity) {
    await reply(deps, transaction, place, `unlinked:${messageKey}`, slackText.unlinked)
    return
  }
  const rows = await transaction.query(
    'SELECT host_id, host_name, hello FROM connector_hosts WHERE account_id = ? ORDER BY host_id',
    [identity.accountId]
  )
  const choice = chooseMachine({
    hosts: rows.flatMap((row) => knownHost(row) ?? []),
    identity,
    channelId: message.channelId,
    text: route.text
  })
  if (choice.kind === 'no_machine') {
    await reply(deps, transaction, place, `update:${messageKey}`, slackText.updateOrca)
    return
  }
  if (choice.kind === 'ask') {
    await reply(deps, transaction, place, `ask:${messageKey}`, slackText.askPlace(choice.options))
    return
  }
  await deliver(route, {
    externalId: `${message.teamId}:${message.channelId}:${message.threadTs}:${message.userId}`,
    hostId: choice.hostId,
    placeId: choice.placeId,
    body: { kind: 'start', agent: choice.agent, placeId: choice.placeId, prompt: route.text }
  })
}

// The owner's next message is a follow-up, or a fresh start on the same machine and project when
// the first one never reached the agent (offline, refused).
async function continueConversation(route: Route, thread: ThreadRow): Promise<void> {
  const { deps, transaction, messageKey, place } = route
  const prompt = await withTeammateContext(transaction, thread.externalId, route.text)
  if (await hasLiveStart(transaction, thread)) {
    await deliver(route, { ...thread, body: { kind: 'send', text: prompt } })
    return
  }
  const [host] = await transaction.query(
    'SELECT host_id, host_name, hello FROM connector_hosts WHERE host_id = ?',
    [thread.hostId]
  )
  const agent = (host && knownHost(host))?.hello.agents.find((name) =>
    CONNECTOR_AGENTS.some((known) => known === name)
  )
  if (!agent) {
    await reply(deps, transaction, place, `update:${messageKey}`, slackText.updateOrca)
    return
  }
  await deliver(route, {
    ...thread,
    body: { kind: 'start', agent, placeId: thread.placeId, prompt }
  })
}

async function deliver(
  route: Route,
  target: { externalId: string; hostId: string; placeId: string; body: DeliveryBody }
): Promise<void> {
  const { deps, transaction, message, messageKey, place } = route
  const queued = await deps.queue(transaction, {
    thread: {
      ...place,
      externalId: target.externalId,
      ownerUserId: message.userId,
      hostId: target.hostId,
      placeId: target.placeId
    },
    deliveryId: messageKey,
    body: target.body
  })
  if (queued !== 'queued') {
    return
  }
  await deps.posts.queue(transaction, {
    ...place,
    postId: `eyes:${messageKey}`,
    kind: 'reaction',
    body: { name: 'eyes', timestamp: message.ts }
  })
  await refreshSlackThread(transaction, deps.posts, target.externalId)
}

async function reply(
  deps: SlackRoutingDeps,
  transaction: CloudDatabase,
  place: SlackPlace,
  postId: string,
  text: string
): Promise<void> {
  await deps.posts.queue(transaction, { ...place, postId, kind: 'message', body: { text } })
}

async function threadsIn(transaction: CloudDatabase, place: SlackPlace): Promise<ThreadRow[]> {
  const rows = await transaction.query(
    `SELECT external_id, owner_user_id, host_id, place_id, pane_key FROM connector_threads
     WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
    [place.teamId, place.channelId, place.threadTs]
  )
  return rows.map((row) => ({
    externalId: String(row.external_id),
    ownerUserId: String(row.owner_user_id),
    hostId: String(row.host_id),
    placeId: String(row.place_id),
    paneKey: row.pane_key === null ? null : String(row.pane_key)
  }))
}

// Linked on the machine, on its way there, or accepted by it.
async function hasLiveStart(transaction: CloudDatabase, thread: ThreadRow): Promise<boolean> {
  if (thread.paneKey !== null) {
    return true
  }
  const [start] = await transaction.query(
    `SELECT state, result FROM connector_inbox
     WHERE host_id = ? AND external_id = ? AND kind = 'start' ORDER BY seq DESC LIMIT 1`,
    [thread.hostId, thread.externalId]
  )
  if (start?.state === 'done') {
    return (
      ConnectorDeliveryResultSchema.safeParse(JSON.parse(String(start.result))).data?.outcome ===
      'accepted'
    )
  }
  return start?.state === 'pending' || start?.state === 'leased' || start?.state === 'received'
}

// Teammates' messages go along once their author is confirmed a full member of the workspace.
async function withTeammateContext(
  transaction: CloudDatabase,
  externalId: string,
  ownerText: string
): Promise<string> {
  const rows = await transaction.query(
    `SELECT c.ts, c.text, u.display_name FROM connector_thread_context c
     JOIN connector_slack_users u
       ON u.team_id = c.team_id AND u.slack_user_id = c.author_user_id AND u.membership = 'member'
     WHERE c.external_id = ? ORDER BY c.ts`,
    [externalId]
  )
  if (rows.length === 0) {
    return ownerText
  }
  await transaction.query(
    `DELETE FROM connector_thread_context
     WHERE external_id = ? AND ts IN (${rows.map(() => '?').join(', ')})`,
    [externalId, ...rows.map((row) => row.ts)]
  )
  return slackText.teammateContext(
    rows.map((row) => ({ name: String(row.display_name), text: String(row.text) })),
    ownerText
  )
}

function knownHost(row: SqlRow): KnownHost | null {
  const hello = ConnectorHelloRequestSchema.safeParse(JSON.parse(String(row.hello)))
  return hello.success
    ? { hostId: String(row.host_id), hostName: String(row.host_name), hello: hello.data }
    : null
}
