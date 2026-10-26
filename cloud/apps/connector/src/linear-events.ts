import { z } from 'zod'

// promptContext carries the whole issue and its threads; the agent's start text stays bounded.
const MAX_START_TEXT_BYTES = 32 * 1024

const UserSchema = z.object({ id: z.string().min(1), name: z.string() })

const CommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  userId: z.string().min(1).nullish()
})

const SessionSchema = z.object({
  id: z.string().min(1),
  // Unset when automation or another agent started the session.
  creatorId: z.string().min(1).nullish(),
  creator: UserSchema.nullish(),
  issue: z
    .object({
      id: z.string().min(1),
      identifier: z.string().min(1),
      title: z.string(),
      description: z.string().nullish(),
      url: z.string().min(1),
      teamId: z.string().min(1)
    })
    .nullish(),
  commentId: z.string().min(1).nullish(),
  comment: z.object({ body: z.string() }).nullish(),
  url: z.string().min(1).nullish()
})

const AgentSessionEventSchema = z.object({
  type: z.literal('AgentSessionEvent'),
  action: z.string(),
  organizationId: z.string().min(1),
  appUserId: z.string().min(1),
  agentSession: SessionSchema,
  promptContext: z.string().nullish(),
  previousComments: z.array(CommentSchema).nullish(),
  agentActivity: z
    .object({
      id: z.string().min(1),
      // The schema types content as an object with body; the prose docs say agentActivity.body.
      content: z.looseObject({ body: z.string().optional() }),
      body: z.string().optional(),
      signal: z.string().nullish(),
      userId: z.string().min(1),
      user: UserSchema
    })
    .nullish()
})

export type LinearUser = z.infer<typeof UserSchema>
export type LinearComment = { id: string; body: string; userId: string | null }

export type LinearSession = {
  id: string
  organizationId: string
  appUserId: string
  creator: LinearUser | null
  issue: {
    id: string
    identifier: string
    title: string
    description: string
    url: string
    teamId: string
  } | null
  commentId: string | null
  url: string | null
}

export type LinearAgentEvent =
  | {
      kind: 'created'
      session: LinearSession
      // What the agent starts from: Linear's promptContext, capped.
      text: string
      // What machine choice reads: the triggering comment, else the issue title.
      choiceText: string
      previousComments: LinearComment[]
    }
  | {
      kind: 'prompted'
      session: LinearSession
      activity: { id: string; author: LinearUser; text: string; stop: boolean }
    }

export type LinearEnvelope =
  | { kind: 'event'; event: LinearAgentEvent }
  | { kind: 'ignored' }
  | { kind: 'invalid' }

// Whole characters only: encodeInto stops before one that would not fit.
function capUtf8(text: string, maxBytes: number): string {
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes))
  return text.slice(0, read)
}

// Only agent session events start or continue work; app, permission and data-change webhooks
// are acknowledged and ignored.
export function readLinearEnvelope(payload: unknown): LinearEnvelope {
  const parsed = AgentSessionEventSchema.safeParse(payload)
  if (!parsed.success) {
    return z.object({ type: z.string() }).safeParse(payload).success
      ? { kind: 'ignored' }
      : { kind: 'invalid' }
  }
  const data = parsed.data
  const { agentSession: raw } = data
  const session: LinearSession = {
    id: raw.id,
    organizationId: data.organizationId,
    appUserId: data.appUserId,
    creator: raw.creatorId ? { id: raw.creatorId, name: raw.creator?.name ?? '' } : null,
    issue: raw.issue ? { ...raw.issue, description: raw.issue.description ?? '' } : null,
    commentId: raw.commentId ?? null,
    url: raw.url ?? null
  }
  if (data.action === 'created') {
    const choiceText = raw.comment?.body ?? raw.issue?.title ?? ''
    return {
      kind: 'event',
      event: {
        kind: 'created',
        session,
        text: capUtf8(data.promptContext ?? choiceText, MAX_START_TEXT_BYTES),
        choiceText,
        previousComments: (data.previousComments ?? []).map((comment) => ({
          ...comment,
          userId: comment.userId ?? null
        }))
      }
    }
  }
  if (data.action === 'prompted' && data.agentActivity) {
    const activity = data.agentActivity
    return {
      kind: 'event',
      event: {
        kind: 'prompted',
        session,
        activity: {
          id: activity.id,
          author: { id: activity.userId, name: activity.user.name },
          text: activity.content.body ?? activity.body ?? '',
          stop: activity.signal === 'stop'
        }
      }
    }
  }
  return { kind: 'ignored' }
}
