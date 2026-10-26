import { randomUUID } from 'node:crypto'
import { ORCA_SCRUB_SAFE_PANE_ENV } from '../../shared/agent-hook-scrub-safe-env'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { callConnector } from './connector'

// The host retries an unavailable cloud itself, waiting out Retry-After, so the call can take a while.
const REPLY_TIMEOUT_MS = 180_000

type ConnectorReply = { status: 'posted' | 'queued' }

export function formatReply(reply: ConnectorReply): string {
  return reply.status === 'posted' ? 'Posted to Slack.' : 'Sent; Orca Cloud will post it to Slack.'
}

export const SLACK_HANDLERS: Record<string, CommandHandler> = {
  'slack reply': async ({ flags, client, json }) => {
    // Claude can scrub names containing KEY from its tools' environment; the alias survives.
    const paneKey = process.env.ORCA_PANE_KEY || process.env[ORCA_SCRUB_SAFE_PANE_ENV]
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Run this from the agent a Slack message started; this terminal is not an Orca agent pane.'
      )
    }
    const reply = await callConnector<ConnectorReply>(
      client,
      'connector.reply',
      // Minted once here, so Orca Cloud posts it once however often the host retries.
      { paneKey, replyId: randomUUID(), text: getRequiredStringFlag(flags, 'text') },
      { timeoutMs: REPLY_TIMEOUT_MS }
    )
    printResult(reply, json, formatReply)
  }
}
