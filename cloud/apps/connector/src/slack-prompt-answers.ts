import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { ConnectorPendingPromptSchema } from '@orca-cloud/connector-contract'
import { z } from 'zod'
import { lockConnectorHost } from './connector-hosts.js'
import type { SlackConfig } from './slack-config.js'
import type { SlackInstalls } from './slack-installs.js'
import type { SlackPosts } from './slack-posts.js'
import { answerDeliveryId, promptCardId, settledCard } from './slack-prompt-cards.js'
import type { QueueInTransaction } from './slack-routing.js'
import { slackText } from './slack-text.js'

const BlockActionsSchema = z.looseObject({
  type: z.literal('block_actions'),
  team: z.looseObject({ id: z.string().min(1) }),
  user: z.looseObject({ id: z.string().min(1) }),
  channel: z.looseObject({ id: z.string().min(1) }),
  container: z.looseObject({ message_ts: z.string().min(1) }),
  actions: z
    .array(z.looseObject({ action_id: z.string(), value: z.string().min(1).optional() }))
    .min(1)
})

// A press of one of a prompt card's buttons; what it answers is found from the message it is on.
export type SlackClick = {
  teamId: string
  channelId: string
  userId: string
  messageTs: string
  optionId: string
}

// Slack sends interactions form-encoded, the JSON in `payload`. Other interactions are ignored.
export function readSlackClick(rawBody: string): SlackClick | 'ignored' | 'invalid' {
  let payload: unknown
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '')
  } catch {
    return 'invalid'
  }
  const parsed = BlockActionsSchema.safeParse(payload)
  if (!parsed.success) {
    return typeof payload === 'object' && payload !== null ? 'ignored' : 'invalid'
  }
  const [action] = parsed.data.actions
  if (!action?.action_id.startsWith('answer:') || action.value === undefined) {
    return 'ignored'
  }
  return {
    teamId: parsed.data.team.id,
    channelId: parsed.data.channel.id,
    userId: parsed.data.user.id,
    messageTs: parsed.data.container.message_ts,
    optionId: action.value
  }
}

// Decisions §1: only the conversation's owner answers. The answer goes to the machine through the
// inbox, once per prompt, and only while the agent still shows that prompt.
export async function answerFromSlack(
  deps: {
    config: SlackConfig
    database: CloudDatabase
    installs: SlackInstalls
    posts: SlackPosts
    queue: QueueInTransaction
  },
  click: SlackClick
): Promise<void> {
  const { config, installs, posts, queue } = deps
  await deps.database.transaction(async (transaction) => {
    const install = await installs.find(transaction, click.teamId)
    const [card] = await transaction.query(
      `SELECT post_id, thread_ts, body FROM connector_slack_posts
       WHERE team_id = ? AND channel_id = ? AND slack_ts = ? AND kind = 'status'`,
      [click.teamId, click.channelId, click.messageTs]
    )
    if (!install || !card) {
      return
    }
    const cardId = String(card.post_id)
    const place = {
      teamId: click.teamId,
      channelId: click.channelId,
      threadTs: String(card.thread_ts)
    }
    const threads = await transaction.query(
      `SELECT external_id, owner_user_id, host_id, place_id FROM connector_threads
       WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
      [place.teamId, place.channelId, place.threadTs]
    )
    const thread = threads.find((row) =>
      cardId.startsWith(promptCardId(String(row.external_id), ''))
    )
    if (!thread) {
      return
    }
    const externalId = String(thread.external_id)
    const ownerUserId = String(thread.owner_user_id)
    const hostId = String(thread.host_id)
    const promptId = cardId.slice(promptCardId(externalId, '').length)
    const tell = (postId: string, text: string) =>
      posts.queue(transaction, {
        ...place,
        postId,
        kind: 'ephemeral',
        body: { text, user: click.userId, threadTs: place.threadTs }
      })
    if (config.paused || install.paused) {
      await tell(
        `paused:${place.teamId}:${place.channelId}:${place.threadTs}:${click.userId}`,
        slackText.paused
      )
      return
    }
    if (click.userId !== ownerUserId) {
      await tell(`only-owner:${cardId}:${click.userId}`, slackText.onlyOwner(ownerUserId))
      return
    }
    // The order events take, so the prompt read here is the one the machine last reported.
    await lockConnectorHost(transaction, hostId)
    await transaction.lockQuotaScope(`orca-connector-slack-status:${externalId}`)
    const [current] = await transaction.query(
      'SELECT pending_prompt FROM connector_threads WHERE external_id = ? AND host_id = ?',
      [externalId, hostId]
    )
    const prompt =
      typeof current?.pending_prompt === 'string'
        ? ConnectorPendingPromptSchema.safeParse(JSON.parse(current.pending_prompt)).data
        : undefined
    const option =
      prompt?.kind !== 'unsupported' && prompt?.promptId === promptId
        ? prompt.options.find((candidate) => candidate.id === click.optionId)
        : undefined
    const queued = option
      ? await queue(transaction, {
          thread: {
            externalId,
            ...place,
            ownerUserId,
            hostId,
            placeId: String(thread.place_id)
          },
          deliveryId: answerDeliveryId(externalId, promptId),
          body: { kind: 'answer', promptId, optionId: click.optionId }
        })
      : undefined
    if (!option || queued !== 'queued') {
      await tell(`moved-on:${cardId}:${click.userId}`, slackText.alreadyAnswered)
      return
    }
    await posts.setStatus(transaction, {
      ...place,
      postId: cardId,
      ...settledCard(
        JSON.parse(String(card.body)),
        slackText.promptAnswered(ownerUserId, option.label)
      )
    })
  })
}
