import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import type { ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import { z } from 'zod'
import { answerablePrompt, promptAnswered, type AnswerablePrompt } from './owner-controls.js'
import type { SlackBlock, SlackPlace, SlackPosts } from './slack-posts.js'
import { slackText } from './slack-text.js'

// Slack's limits: buttons per actions block, characters per button label.
const MAX_BUTTONS = 25
const MAX_BUTTON_LABEL_CHARS = 75

const CardBodySchema = z.object({
  blocks: z.array(z.looseObject({ type: z.string() })).optional()
})

export const promptCardId = (externalId: string, promptId: string) =>
  `prompt:${externalId}:${promptId}`

// An answerable prompt whose options all fit on buttons; anything else is answered in Orca.
export function slackAnswerablePrompt(
  thread: SqlRow,
  hello: ConnectorHelloRequest | undefined
): AnswerablePrompt | null {
  const prompt = answerablePrompt(thread, hello)
  const fits =
    prompt !== null &&
    prompt.options.length > 0 &&
    prompt.options.length <= MAX_BUTTONS &&
    prompt.options.every((option) => option.label.trim().length > 0) &&
    slackText.promptCard(prompt).length > 0
  return fits ? prompt : null
}

// The status message's blocks: its text, and Stop while the owner can stop the turn. Always sent, so
// an edit that drops the button replaces the old blocks.
export function statusBlocks(text: string, stoppableTurnId: number | null): SlackBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    ...(stoppableTurnId === null
      ? []
      : [
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'stop',
                text: { type: 'plain_text', text: slackText.stopButton },
                value: String(stoppableTurnId)
              }
            ]
          }
        ])
  ]
}

function openCard(prompt: AnswerablePrompt): { text: string; blocks: SlackBlock[] } {
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
  prompt: AnswerablePrompt | null
): Promise<void> {
  const { hostId, externalId } = thread
  const openId =
    prompt && !(await promptAnswered(transaction, hostId, externalId, prompt.promptId))
      ? promptCardId(externalId, prompt.promptId)
      : null
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
