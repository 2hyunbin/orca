import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SlackResult } from './slack-web-api.js'

const DISCORD_API_ORIGIN = 'https://discord.com/api/v10'
const DISCORD_API_TIMEOUT_MS = 10_000
const NONCE_LENGTH = 25
// Discord checks a nonce "in the past few minutes" without saying how many; past this, a stale
// send can't be deduplicated and is uncertain.
const NONCE_WINDOW_MS = 2 * 60_000

// Same outcome shape as Slack's client, so the post worker treats both alike.
export type DiscordResult = SlackResult

export type DiscordRoute = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  path: string
  body?: Record<string, unknown>
}

// replyTo: answer that message, pinging only its writer; otherwise our text pings no one.
export type DiscordMessageBody = { content: string; components?: unknown[]; replyTo?: string }

function messageBody({ replyTo, ...message }: DiscordMessageBody): Record<string, unknown> {
  return replyTo === undefined
    ? { ...message, allowed_mentions: { parse: [] } }
    : {
        ...message,
        message_reference: { message_id: replyTo, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: true }
      }
}

// Discord nonces are at most 25 characters; a post id can be longer.
export function discordNonce(postId: string): string {
  return createHash('sha256').update(postId).digest('base64url').slice(0, NONCE_LENGTH)
}

// Whether a resend of a post first sent at sentAt still dedupes on its nonce.
export function nonceStillDedupes(sentAt: number, now: number): boolean {
  return now - sentAt < NONCE_WINDOW_MS
}

// https://docs.discord.com/developers/resources/message,
// https://docs.discord.com/developers/resources/channel, https://docs.discord.com/developers/resources/guild
export const discordRoutes = {
  // The thread takes the message's id.
  startThread: (channelId: string, messageId: string, name: string): DiscordRoute => ({
    method: 'POST',
    path: `/channels/${channelId}/messages/${messageId}/threads`,
    body: { name }
  }),
  // With enforce_nonce, a resend of the same post returns the message the first send created.
  createMessage: (
    channelId: string,
    message: DiscordMessageBody,
    postId: string
  ): DiscordRoute => ({
    method: 'POST',
    path: `/channels/${channelId}/messages`,
    body: { ...messageBody(message), nonce: discordNonce(postId), enforce_nonce: true }
  }),
  editMessage: (
    channelId: string,
    messageId: string,
    message: DiscordMessageBody
  ): DiscordRoute => ({
    method: 'PATCH',
    path: `/channels/${channelId}/messages/${messageId}`,
    body: messageBody(message)
  }),
  // A unicode emoji, or a custom one as name:id; adding it twice is not an error.
  addReaction: (channelId: string, messageId: string, emoji: string): DiscordRoute => ({
    method: 'PUT',
    path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  }),
  // Newest first.
  messagesBefore: (channelId: string, messageId: string, limit: number): DiscordRoute => ({
    method: 'GET',
    path: `/channels/${channelId}/messages?${new URLSearchParams({ before: messageId, limit: String(limit) })}`
  }),
  guildMember: (guildId: string, userId: string): DiscordRoute => ({
    method: 'GET',
    path: `/guilds/${guildId}/members/${userId}`
  })
}

export type DiscordRestApi = (botToken: string, route: DiscordRoute) => Promise<DiscordResult>

const RateLimitedSchema = z.looseObject({ retry_after: z.number().nonnegative() })
const ErrorSchema = z.looseObject({ code: z.number().int() })

function seconds(value: string | null): number | undefined {
  const parsed = Number(value)
  return value !== null && value !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined
}

// Plain HTTPS. The post queue sends one head per thread, so a 429 is retried after Discord's
// retry_after rather than tracked per bucket. A JSON array (message history) is returned as
// body.items.
export function createDiscordRestApi(
  request: typeof fetch = (input, init) => fetch(input, init)
): DiscordRestApi {
  return async (botToken, route) => {
    let response: Response
    try {
      response = await request(`${DISCORD_API_ORIGIN}${route.path}`, {
        method: route.method,
        headers: {
          authorization: `Bot ${botToken}`,
          ...(route.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    const body: unknown = response.status === 204 ? {} : await response.json().catch(() => null)
    if (response.status === 429) {
      const limited = RateLimitedSchema.safeParse(body)
      const afterSeconds = limited.success
        ? limited.data.retry_after
        : seconds(response.headers.get('retry-after'))
      return afterSeconds === undefined
        ? { kind: 'retry' }
        : { kind: 'retry', afterMs: afterSeconds * 1000 }
    }
    if (response.status >= 500) {
      return { kind: 'unknown' }
    }
    if (!response.ok) {
      // 401 and 403 count toward Discord's invalid-request ban, so they are never retried.
      if (response.status === 401 || response.status === 403) {
        console.warn(
          JSON.stringify({ event: 'orca_connector_discord_refused', status: response.status })
        )
      }
      const error = ErrorSchema.safeParse(body)
      return {
        kind: 'failed',
        error: error.success ? String(error.data.code) : `http_${response.status}`
      }
    }
    if (Array.isArray(body)) {
      return { kind: 'ok', body: { items: body } }
    }
    const parsed = z.looseObject({}).safeParse(body)
    return parsed.success ? { kind: 'ok', body: parsed.data } : { kind: 'unknown' }
  }
}
