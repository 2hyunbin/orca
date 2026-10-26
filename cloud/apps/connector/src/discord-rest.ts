import { z } from 'zod'
import type { SlackResult } from './slack-web-api.js'

const DISCORD_API_ORIGIN = 'https://discord.com/api/v10'
const DISCORD_API_TIMEOUT_MS = 10_000
// https://docs.discord.com/developers/topics/rate-limits
const GLOBAL_LIMIT_PER_SECOND = 50
const MAX_TRACKED_LIMITS = 10_000
const EPHEMERAL = 1 << 6
// Our text never pings anyone.
const NO_MENTIONS = { parse: [] }

// Same outcome shape as Slack's client, so the post worker treats both alike.
export type DiscordResult = SlackResult

export type DiscordRoute = {
  method: 'POST' | 'PATCH' | 'PUT'
  path: string
  body?: Record<string, unknown>
  // Method and path with the ids dropped, and the top-level resource the route's limit is counted
  // per (a channel, or an interaction's webhook).
  routeKey: string
  resource: string
  // Interaction followups use the interaction token instead of the bot token and are exempt from
  // the global limit.
  interaction: boolean
}

export type DiscordMessageBody = { content: string; components?: unknown[] }

export const discordRoutes = {
  // The thread takes the message's id.
  startThread: (channelId: string, messageId: string, name: string): DiscordRoute => ({
    method: 'POST',
    path: `/channels/${channelId}/messages/${messageId}/threads`,
    body: { name },
    routeKey: 'POST /channels/:channel/messages/:message/threads',
    resource: `channels/${channelId}`,
    interaction: false
  }),
  createMessage: (channelId: string, message: DiscordMessageBody): DiscordRoute => ({
    method: 'POST',
    path: `/channels/${channelId}/messages`,
    body: { ...message, allowed_mentions: NO_MENTIONS },
    routeKey: 'POST /channels/:channel/messages',
    resource: `channels/${channelId}`,
    interaction: false
  }),
  editMessage: (
    channelId: string,
    messageId: string,
    message: DiscordMessageBody
  ): DiscordRoute => ({
    method: 'PATCH',
    path: `/channels/${channelId}/messages/${messageId}`,
    body: { ...message, allowed_mentions: NO_MENTIONS },
    routeKey: 'PATCH /channels/:channel/messages/:message',
    resource: `channels/${channelId}`,
    interaction: false
  }),
  // A unicode emoji, or a custom one as name:id; adding it twice is not an error.
  addReaction: (channelId: string, messageId: string, emoji: string): DiscordRoute => ({
    method: 'PUT',
    path: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    routeKey: 'PUT /channels/:channel/messages/:message/reactions/:emoji/@me',
    resource: `channels/${channelId}`,
    interaction: false
  }),
  // Valid for 15 minutes after the interaction.
  ephemeralFollowup: (applicationId: string, token: string, content: string): DiscordRoute => ({
    method: 'POST',
    path: `/webhooks/${applicationId}/${token}`,
    body: { content, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS },
    routeKey: 'POST /webhooks/:application/:token',
    resource: `webhooks/${applicationId}/${token}`,
    interaction: true
  })
}

export type DiscordRestApi = (botToken: string, route: DiscordRoute) => Promise<DiscordResult>

const RateLimitedSchema = z.looseObject({
  retry_after: z.number().nonnegative(),
  global: z.boolean().optional()
})
const ErrorSchema = z.looseObject({ code: z.number().int() })

type Limit = { remaining: number; resetAt: number }

function seconds(value: string | null): number | undefined {
  const parsed = Number(value)
  return value !== null && value !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined
}

// Keeps what the last responses said about each limit and answers retry without sending while
// one is spent, so we don't spend Discord's invalid-request allowance on 429s. Per process:
// another instance's sends are only seen through Discord's own 429s.
export function createDiscordRestApi(
  request: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now
): DiscordRestApi {
  // routeKey -> the bucket Discord reported for it. A limit is counted per bucket and resource,
  // or per route and resource until a response names the bucket.
  const buckets = new Map<string, string>()
  const limits = new Map<string, Limit>()
  let globalUntil = 0
  let window = { second: 0, sent: 0 }

  const limitKey = (route: DiscordRoute): string =>
    `${buckets.get(route.routeKey) ?? route.routeKey} ${route.resource}`

  const remember = (key: string, limit: Limit): void => {
    limits.delete(key)
    limits.set(key, limit)
    if (limits.size > MAX_TRACKED_LIMITS) {
      const oldest = limits.keys().next().value
      if (oldest !== undefined) {
        limits.delete(oldest)
      }
    }
  }

  // Milliseconds until this route may send, or 0 after counting the send.
  const wait = (route: DiscordRoute): number => {
    const at = now()
    const limit = limits.get(limitKey(route))
    if (limit !== undefined && limit.remaining <= 0 && limit.resetAt > at) {
      return limit.resetAt - at
    }
    if (route.interaction) {
      return 0
    }
    if (globalUntil > at) {
      return globalUntil - at
    }
    const second = Math.floor(at / 1000)
    window = window.second === second ? window : { second, sent: 0 }
    if (window.sent >= GLOBAL_LIMIT_PER_SECOND) {
      return (second + 1) * 1000 - at
    }
    window.sent += 1
    return 0
  }

  const learn = (route: DiscordRoute, headers: Headers): void => {
    const bucket = headers.get('x-ratelimit-bucket')
    if (bucket !== null) {
      buckets.set(route.routeKey, bucket)
    }
    const remaining = seconds(headers.get('x-ratelimit-remaining'))
    const resetAfter = seconds(headers.get('x-ratelimit-reset-after'))
    if (remaining !== undefined && resetAfter !== undefined) {
      remember(limitKey(route), { remaining, resetAt: now() + resetAfter * 1000 })
    }
  }

  return async (botToken, route) => {
    const waitMs = wait(route)
    if (waitMs > 0) {
      return { kind: 'retry', afterMs: waitMs }
    }
    let response: Response
    try {
      response = await request(`${DISCORD_API_ORIGIN}${route.path}`, {
        method: route.method,
        headers: {
          ...(route.interaction ? {} : { authorization: `Bot ${botToken}` }),
          ...(route.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        signal: AbortSignal.timeout(DISCORD_API_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    learn(route, response.headers)
    const body: unknown = response.status === 204 ? {} : await response.json().catch(() => null)
    if (response.status === 429) {
      const limited = RateLimitedSchema.safeParse(body)
      const afterSeconds = limited.success
        ? limited.data.retry_after
        : seconds(response.headers.get('retry-after'))
      if (afterSeconds === undefined) {
        return { kind: 'retry' }
      }
      const afterMs = afterSeconds * 1000
      const global =
        response.headers.get('x-ratelimit-global') === 'true' ||
        (limited.success && limited.data.global === true)
      if (global) {
        globalUntil = now() + afterMs
      } else {
        remember(limitKey(route), { remaining: 0, resetAt: now() + afterMs })
      }
      return { kind: 'retry', afterMs }
    }
    if (response.status >= 500) {
      return { kind: 'unknown' }
    }
    if (!response.ok) {
      const error = ErrorSchema.safeParse(body)
      return {
        kind: 'failed',
        error: error.success ? String(error.data.code) : `http_${response.status}`
      }
    }
    const parsed = z.looseObject({}).safeParse(body)
    return parsed.success ? { kind: 'ok', body: parsed.data } : { kind: 'unknown' }
  }
}
