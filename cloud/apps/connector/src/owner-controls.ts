import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import {
  ConnectorPendingPromptSchema,
  type ConnectorHelloRequest,
  type ConnectorPendingPrompt
} from '@orca-cloud/connector-contract'
import { lockConnectorHost } from './connector-hosts.js'
import type { queueDelivery } from './queue-delivery.js'

// What an owner can do to their conversation from any connected app: answer the agent's prompt,
// or stop its turn (decisions §1: only the owner). Each goes to the machine through the inbox.
export type OwnerAction =
  | { kind: 'answer'; promptId: string; optionId: string }
  | { kind: 'stop'; turnId: number }

export type OwnerActionOutcome =
  | { kind: 'not_owner'; ownerUserId: string }
  // The agent no longer shows that prompt or runs that turn, or it was already done once.
  | { kind: 'moved_on' }
  | { kind: 'answered'; ownerUserId: string; label: string }
  | { kind: 'stopping' }

export type AnswerablePrompt = Extract<ConnectorPendingPrompt, { kind: 'approval' | 'question' }>

type QueueInTransaction = (
  transaction: CloudDatabase,
  input: Parameters<typeof queueDelivery>[1]
) => ReturnType<typeof queueDelivery>

// One answer per prompt, one stop per turn: repeated presses are duplicates in the inbox.
export const answerDeliveryId = (externalId: string, promptId: string) =>
  `answer:${externalId}:${promptId}`
const stopDeliveryId = (externalId: string, turnId: number) => `stop:${externalId}:${turnId}`

export function pendingPrompt(thread: SqlRow): ConnectorPendingPrompt | undefined {
  return typeof thread.pending_prompt === 'string'
    ? ConnectorPendingPromptSchema.safeParse(JSON.parse(thread.pending_prompt)).data
    : undefined
}

// The thread's pending prompt when its machine takes answers of that kind.
export function answerablePrompt(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): AnswerablePrompt | null {
  const prompt = pendingPrompt(thread)
  return prompt &&
    prompt.kind !== 'unsupported' &&
    hello?.features.includes('answer') &&
    hello.promptKinds.includes(prompt.kind)
    ? prompt
    : null
}

// An answer to that prompt is already on its way or done.
export async function promptAnswered(
  transaction: CloudDatabase,
  hostId: string,
  externalId: string,
  promptId: string
): Promise<boolean> {
  const [row] = await transaction.query(
    'SELECT 1 AS found FROM connector_inbox WHERE host_id = ? AND delivery_id = ?',
    [hostId, answerDeliveryId(externalId, promptId)]
  )
  return row !== undefined
}

// The open turn, when its machine takes a stop.
export function stoppableTurn(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): number | null {
  return thread.turn_state === 'working' &&
    thread.open_turn_id !== null &&
    hello?.features.includes('cancel')
    ? Number(thread.open_turn_id)
    : null
}

// Decided under the host lock the machine's events are applied under, so the prompt and turn read
// here are the ones the machine last reported.
export async function applyOwnerAction(
  transaction: CloudDatabase,
  queue: QueueInTransaction,
  externalId: string,
  actorUserId: string,
  action: OwnerAction
): Promise<OwnerActionOutcome | null> {
  const [found] = await transaction.query(
    'SELECT host_id, owner_user_id FROM connector_threads WHERE external_id = ?',
    [externalId]
  )
  if (!found) {
    return null
  }
  const ownerUserId = String(found.owner_user_id)
  if (actorUserId !== ownerUserId) {
    return { kind: 'not_owner', ownerUserId }
  }
  const hostId = String(found.host_id)
  await lockConnectorHost(transaction, hostId)
  const [thread] = await transaction.query(
    'SELECT * FROM connector_threads WHERE external_id = ? AND host_id = ?',
    [externalId, hostId]
  )
  if (!thread) {
    return { kind: 'moved_on' }
  }
  const target = {
    externalId,
    teamId: String(thread.team_id),
    channelId: String(thread.channel_id),
    threadTs: String(thread.thread_ts),
    ownerUserId,
    hostId,
    placeId: String(thread.place_id)
  }
  if (action.kind === 'stop') {
    if (thread.turn_state !== 'working' || Number(thread.open_turn_id) !== action.turnId) {
      return { kind: 'moved_on' }
    }
    const queued = await queue(transaction, {
      thread: target,
      deliveryId: stopDeliveryId(externalId, action.turnId),
      body: { kind: 'cancel' }
    })
    return queued === 'queued' ? { kind: 'stopping' } : { kind: 'moved_on' }
  }
  const prompt = pendingPrompt(thread)
  const option =
    prompt?.kind !== 'unsupported' && prompt?.promptId === action.promptId
      ? prompt.options.find((candidate) => candidate.id === action.optionId)
      : undefined
  if (!option) {
    return { kind: 'moved_on' }
  }
  const queued = await queue(transaction, {
    thread: target,
    deliveryId: answerDeliveryId(externalId, action.promptId),
    body: { kind: 'answer', promptId: action.promptId, optionId: action.optionId }
  })
  return queued === 'queued'
    ? { kind: 'answered', ownerUserId, label: option.label }
    : { kind: 'moved_on' }
}
