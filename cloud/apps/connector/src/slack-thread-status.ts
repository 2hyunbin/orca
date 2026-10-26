import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import { ConnectorDeliveryResultSchema } from '@orca-cloud/connector-contract'
import type { SlackPosts } from './slack-posts.js'
import { escapeSlackText, slackText } from './slack-text.js'

// A turn's last message is posted only if the agent hasn't replied itself by then.
const FALLBACK_DELAY_MS = 5_000

// What a thread shows, derived from its routing record and newest message; every queued post is
// keyed by what it reports, so refreshing twice changes nothing.
export async function refreshSlackThread(
  transaction: CloudDatabase,
  posts: SlackPosts,
  externalId: string
): Promise<void> {
  const [thread] = await transaction.query(
    `SELECT t.*, h.host_name FROM connector_threads t
     JOIN connector_hosts h ON h.host_id = t.host_id WHERE t.external_id = ?`,
    [externalId]
  )
  if (!thread) {
    return
  }
  const [latest] = await transaction.query(
    `SELECT delivery_id, state, result FROM connector_inbox
     WHERE host_id = ? AND external_id = ? AND kind IN ('start', 'send')
     ORDER BY seq DESC LIMIT 1`,
    [thread.host_id, externalId]
  )
  const place = {
    teamId: String(thread.team_id),
    channelId: String(thread.channel_id),
    threadTs: String(thread.thread_ts)
  }
  const hostName = String(thread.host_name)
  await posts.setStatus(transaction, {
    ...place,
    postId: `status:${externalId}`,
    text: statusText(thread, latest, hostName)
  })
  if (latest?.state === 'expired') {
    await posts.queue(transaction, {
      ...place,
      postId: `offline:${externalId}:${String(latest.delivery_id)}`,
      kind: 'message',
      body: { text: slackText.offline(hostName) }
    })
  }
  if (thread.turn_state === 'ended' && thread.turn_last_message !== null) {
    const turnKey = `${externalId}:${String(thread.open_turn_id)}`
    if (!(await posts.hasReplyForTurn(transaction, turnKey))) {
      await posts.queue(transaction, {
        ...place,
        postId: `fallback:${turnKey}`,
        kind: 'message',
        body: { text: escapeSlackText(String(thread.turn_last_message)) },
        turnKey,
        delayMs: FALLBACK_DELAY_MS
      })
    }
  }
}

function statusText(thread: SqlRow, latest: SqlRow | undefined, hostName: string): string {
  if (thread.pending_prompt !== null) {
    return slackText.status.needsAnswer(hostName)
  }
  if (thread.turn_state === 'working') {
    return slackText.status.working(hostName)
  }
  const result =
    latest?.state === 'done'
      ? ConnectorDeliveryResultSchema.safeParse(JSON.parse(String(latest.result))).data
      : undefined
  switch (latest?.state) {
    case 'pending':
    case 'leased':
      return slackText.status.waiting(hostName)
    case 'expired':
      return slackText.status.offline(hostName)
  }
  switch (result?.outcome) {
    case 'refused':
      return slackText.status.refused(hostName, result.reason)
    case 'unsupported':
      return slackText.status.refused(hostName, 'unsupported')
    case 'expired':
      return slackText.status.offline(hostName)
    case 'unknown':
      return slackText.status.unknown
  }
  if (thread.turn_state === 'unverifiable') {
    return slackText.status.noUpdate
  }
  if (thread.turn_state === 'ended') {
    return slackText.status.done(hostName)
  }
  return latest ? slackText.status.working(hostName) : slackText.status.waiting(hostName)
}
