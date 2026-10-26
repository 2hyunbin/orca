import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  ConnectorPendingPromptSchema,
  type ConnectorHelloRequest,
  type ConnectorPendingPrompt
} from '@orca-cloud/connector-contract'
import { z } from 'zod'
import type { SlackBlock, SlackPlace, SlackPosts } from './slack-posts.js'
import { slackText } from './slack-text.js'

// Slack's limits: buttons per actions block, characters per button label.
const MAX_BUTTONS = 25
const MAX_BUTTON_LABEL_CHARS = 75

export type SlackAnswerablePrompt = Extract<
  ConnectorPendingPrompt,
  { kind: 'approval' | 'question' }
>

const CardBodySchema = z.object({
  blocks: z.array(z.looseObject({ type: z.string() })).optional()
})

export const promptCardId = (externalId: string, promptId: string) =>
  `prompt:${externalId}:${promptId}`

export const answerDeliveryId = (externalId: string, promptId: string) =>
  `answer:${externalId}:${promptId}`

// The thread's pending prompt when Slack can answer it: the machine takes answers of its kind and
// every option fits on a button. Anything else is answered in Orca.
export function answerablePrompt(
  pendingPrompt: unknown,
  hello: ConnectorHelloRequest | undefined
): SlackAnswerablePrompt | null {
  const parsed =
    typeof pendingPrompt === 'string'
      ? ConnectorPendingPromptSchema.safeParse(JSON.parse(pendingPrompt)).data
      : undefined
  if (
    parsed === undefined ||
    parsed.kind === 'unsupported' ||
    !hello?.features.includes('answer') ||
    !hello.promptKinds.includes(parsed.kind)
  ) {
    return null
  }
  const fits =
    parsed.options.length > 0 &&
    parsed.options.length <= MAX_BUTTONS &&
    parsed.options.every((option) => option.label.trim().length > 0) &&
    slackText.promptCard(parsed).length > 0
  return fits ? parsed : null
}

function openCard(prompt: SlackAnswerablePrompt): { text: string; blocks: SlackBlock[] } {
  const text = slackText.promptCard(prompt)
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: prompt.options.map((option, index) => ({
          type: 'button',
          action_id: `answer:${index}`,
          text: { type: 'plain_text', text: option.label.slice(0, MAX_BUTTON_LABEL_CHARS) },
          value: option.id
        }))
      }
    ]
  }
}

// What the card asked, with its buttons replaced by a closing note.
export function settledCard(body: unknown, note: string): { text: string; blocks: SlackBlock[] } {
  const asked = CardBodySchema.safeParse(body).data?.blocks?.[0]
  return {
    text: note,
    blocks: [
      ...(asked ? [asked] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: note }] }
    ]
  }
}

function isOpen(body: unknown): boolean {
  return (
    CardBodySchema.safeParse(body).data?.blocks?.some((block) => block.type === 'actions') ?? false
  )
}

// The conversation's prompt cards as a projection, beside its status and under the same lock: the
// unanswered pending prompt's card is open; any other open card closes. Answered cards are final.
export async function refreshPromptCards(
  transaction: CloudDatabase,
  posts: SlackPosts,
  thread: SlackPlace & { hostId: string; externalId: string },
  prompt: SlackAnswerablePrompt | null
): Promise<void> {
  const { hostId, externalId } = thread
  const [answered] = prompt
    ? await transaction.query(
        'SELECT 1 AS found FROM connector_inbox WHERE host_id = ? AND delivery_id = ?',
        [hostId, answerDeliveryId(externalId, prompt.promptId)]
      )
    : []
  const openId = prompt && !answered ? promptCardId(externalId, prompt.promptId) : null
  if (prompt && openId) {
    await posts.setStatus(transaction, { ...thread, postId: openId, ...openCard(prompt) })
  }
  const cards = await transaction.query(
    `SELECT post_id, body FROM connector_slack_posts WHERE kind = 'status' AND post_id LIKE ?`,
    [`${promptCardId(externalId, '')}%`]
  )
  for (const card of cards) {
    const body: unknown = JSON.parse(String(card.body))
    if (String(card.post_id) !== openId && isOpen(body)) {
      await posts.setStatus(transaction, {
        ...thread,
        postId: String(card.post_id),
        ...settledCard(body, slackText.promptClosed)
      })
    }
  }
}
