import { createHash } from 'node:crypto'
import { z } from 'zod'

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const LINEAR_API_TIMEOUT_MS = 10_000
// Rate-limit windows: a family whose remaining count is spent resets at this header (UTC epoch ms).
const RATE_LIMIT_FAMILIES = ['requests', 'complexity', 'endpoint-requests'] as const

const GraphqlErrorSchema = z.looseObject({
  message: z.string().optional(),
  // Rate limits are documented as extensions.code; the SDK reads extensions.type.
  extensions: z.looseObject({ code: z.string().optional(), type: z.string().optional() }).optional()
})
const GraphqlResponseSchema = z.looseObject({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(GraphqlErrorSchema).optional()
})

// Same outcomes as SlackResult, so one post worker can drive either provider.
export type LinearResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'retry'; afterMs?: number }
  // The request may or may not have reached Linear.
  | { kind: 'unknown' }

export type LinearRequest = { query: string; variables: Record<string, unknown> }

export type LinearGraphql = (token: string, request: LinearRequest) => Promise<LinearResult>

function isRateLimit(error: z.infer<typeof GraphqlErrorSchema>): boolean {
  return error.extensions?.code === 'RATELIMITED' || error.extensions?.type === 'ratelimited'
}

// Retry-After (seconds) when sent; otherwise the latest reset among the spent windows.
function rateLimitAfterMs(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = Number(headers.get('retry-after') ?? Number.NaN)
  if (Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter * 1000)
  }
  const resets = RATE_LIMIT_FAMILIES.filter(
    (family) => Number(headers.get(`x-ratelimit-${family}-remaining`) ?? Number.NaN) <= 0
  )
    .map((family) => Number(headers.get(`x-ratelimit-${family}-reset`) ?? Number.NaN))
    .filter(Number.isFinite)
  return resets.length === 0 ? undefined : Math.max(0, Math.max(...resets) - nowMs)
}

export function createLinearGraphql(
  request: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now
): LinearGraphql {
  return async (token, { query, variables }) => {
    let response: Response
    try {
      response = await request(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LINEAR_API_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    if (response.status >= 500) {
      return { kind: 'unknown' }
    }
    const parsed = GraphqlResponseSchema.safeParse(await response.json().catch(() => null))
    const errors = parsed.success ? (parsed.data.errors ?? []) : []
    // Linear answers a rate limit with HTTP 400 and RATELIMITED; 429 is any proxy's equivalent.
    if (response.status === 429 || errors.some(isRateLimit)) {
      const afterMs = rateLimitAfterMs(response.headers, now())
      return afterMs === undefined ? { kind: 'retry' } : { kind: 'retry', afterMs }
    }
    if (response.status === 401) {
      return { kind: 'failed', error: 'authentication error' }
    }
    if (!parsed.success) {
      return { kind: 'unknown' }
    }
    const [error] = errors
    if (error) {
      return {
        kind: 'failed',
        error: error.extensions?.type ?? error.extensions?.code ?? 'graphql error'
      }
    }
    return parsed.data.data ? { kind: 'ok', body: parsed.data.data } : { kind: 'unknown' }
  }
}

// What a session shows: ephemeral thoughts and actions are replaced by the next activity.
export type LinearActivity =
  | { type: 'thought'; body: string; ephemeral?: boolean }
  | { type: 'action'; action: string; parameter: string; result?: string; ephemeral?: boolean }
  | { type: 'elicitation'; body: string }
  // Choices the user may pick or ignore; a pick arrives as an ordinary prompt.
  | { type: 'elicitation'; body: string; select: { label?: string; value: string }[] }
  // "Link account", shown only to userId when given.
  | {
      type: 'elicitation'
      body: string
      auth: { url: string; userId?: string; providerName?: string }
    }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string }

const ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`

const SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`

// Linear takes a client-chosen UUID v4 per activity, so a resend after a lost reply names the same one.
export function linearActivityId(postId: string): string {
  const bytes = createHash('sha256').update(`linear-activity:${postId}`).digest().subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function activityCreateRequest(
  sessionId: string,
  postId: string,
  activity: LinearActivity
): LinearRequest {
  const input: Record<string, unknown> = { agentSessionId: sessionId, id: linearActivityId(postId) }
  if ('select' in activity) {
    const { select, ...content } = activity
    Object.assign(input, { content, signal: 'select', signalMetadata: { options: select } })
  } else if ('auth' in activity) {
    const { auth, ...content } = activity
    Object.assign(input, { content, signal: 'auth', signalMetadata: auth })
  } else if ('ephemeral' in activity) {
    const { ephemeral, ...content } = activity
    Object.assign(input, { content, ephemeral })
  } else {
    input.content = activity
  }
  return { query: ACTIVITY_CREATE, variables: { input } }
}

export type LinearPlanStep = {
  content: string
  status: 'pending' | 'inProgress' | 'completed' | 'canceled'
}

// Both fields replace what the session had: links (e.g. the pull request) and the whole plan.
export function sessionUpdateRequest(
  sessionId: string,
  update: { externalUrls?: { label: string; url: string }[]; plan?: LinearPlanStep[] }
): LinearRequest {
  return { query: SESSION_UPDATE, variables: { id: sessionId, input: update } }
}
