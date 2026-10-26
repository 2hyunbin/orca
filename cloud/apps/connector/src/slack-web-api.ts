import { z } from 'zod'

const SLACK_API_ORIGIN = 'https://slack.com/api'
const SLACK_API_TIMEOUT_MS = 10_000
// Errors Slack documents as transient; any other ok:false is final for that call.
const TRANSIENT_ERRORS = new Set([
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
  'ratelimited'
])

const SlackResponseSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

export type SlackResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'retry'; afterMs?: number }
  // The request may or may not have reached Slack.
  | { kind: 'unknown' }

export type SlackWebApi = (
  token: string,
  method: string,
  args: Record<string, unknown>
) => Promise<SlackResult>

function retryAfterMs(value: string | null): number | undefined {
  const seconds = Number(value)
  return value !== null && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined
}

// Plain HTTPS, as Paseo Hub does; GET methods take their arguments as a query string.
export function createSlackWebApi(
  request: typeof fetch = (input, init) => fetch(input, init)
): SlackWebApi {
  return async (token, method, args) => {
    const read = method === 'users.info' || method === 'conversations.replies'
    const url = new URL(`${SLACK_API_ORIGIN}/${method}`)
    if (read) {
      for (const [name, value] of Object.entries(args)) {
        url.searchParams.set(name, String(value))
      }
    }
    let response: Response
    try {
      response = await request(url, {
        method: read ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(read ? {} : { 'content-type': 'application/json; charset=utf-8' })
        },
        ...(read ? {} : { body: JSON.stringify(args) }),
        signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    if (response.status === 429) {
      const afterMs = retryAfterMs(response.headers.get('retry-after'))
      return afterMs === undefined ? { kind: 'retry' } : { kind: 'retry', afterMs }
    }
    if (response.status >= 500) {
      return { kind: 'unknown' }
    }
    const parsed = SlackResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      return { kind: 'unknown' }
    }
    if (parsed.data.ok) {
      return { kind: 'ok', body: parsed.data }
    }
    const error = parsed.data.error ?? 'unknown_error'
    return TRANSIENT_ERRORS.has(error) ? { kind: 'retry' } : { kind: 'failed', error }
  }
}
