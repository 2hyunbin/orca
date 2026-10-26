import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { callConnector } from './connector'

const REPLY_ATTEMPTS = 3
const REPLY_RETRY_DELAY_MS = 2_000

type ConnectorReply = { status: 'posted' | 'queued' }

export function formatReply(reply: ConnectorReply): string {
  return reply.status === 'posted' ? 'Posted to Slack.' : 'Sent; Orca Cloud will post it to Slack.'
}

export const SLACK_HANDLERS: Record<string, CommandHandler> = {
  'slack reply': async ({ flags, client, json }) => {
    const paneKey = process.env.ORCA_PANE_KEY
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Run this from the agent a Slack message started; this terminal is not an Orca agent pane.'
      )
    }
    const text = getRequiredStringFlag(flags, 'text')
    // One id for every attempt, so Orca Cloud posts it once however many answers are lost.
    const replyId = randomUUID()
    for (let attempt = 1; ; attempt++) {
      try {
        const reply = await callConnector<ConnectorReply>(client, 'connector.reply', {
          paneKey,
          replyId,
          text
        })
        printResult(reply, json, formatReply)
        return
      } catch (error) {
        const retryable =
          error instanceof RuntimeClientError && error.code === 'connector_unavailable'
        if (!retryable || attempt >= REPLY_ATTEMPTS) {
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, REPLY_RETRY_DELAY_MS))
      }
    }
  }
}
