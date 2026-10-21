// The history an ACP agent replays when it reopens a conversation, read back as whole turns. A
// turn starts at a person's message: its chunks (text first, then attachments) share that
// message, and everything after them until the next person's message is the turn's work. The id
// each turn gets is the agent's own: OpenCode's saved user message id, or Grok's prompt id, which
// for a turn Orca sent is the id Orca gave it.

import { z } from 'zod'
import type { NativeChatBlock } from '../../shared/native-chat-types'

/** What one load may keep for catch-up; a larger history is not caught up at all. */
const LOAD_HISTORY_MAX_FRAMES = 20_000
const LOAD_HISTORY_MAX_BYTES = 16 * 1024 * 1024

/** One notification the agent sent while it replayed its history, as received. */
export type AcpLoadHistoryFrame = { method: string; params: unknown }

/** A bounded copy of what one session's load replayed, in arrival order, its own frames only. */
export class AcpLoadHistory {
  private kept: AcpLoadHistoryFrame[] | null = []
  private bytes = 0

  constructor(private readonly providerSessionId: string) {}

  keep(method: string, params: unknown): void {
    if (!this.kept || sessionSchema.safeParse(params).data?.sessionId !== this.providerSessionId) {
      return
    }
    this.bytes += JSON.stringify(params).length
    this.kept.push({ method, params })
    if (this.kept.length > LOAD_HISTORY_MAX_FRAMES || this.bytes > LOAD_HISTORY_MAX_BYTES) {
      this.kept = null
    }
  }

  /** Null once the history outgrew what a load keeps. */
  frames(): AcpLoadHistoryFrame[] | null {
    return this.kept
  }
}

/** Where a replayed turn's id comes from. */
export type AcpHistoryTurnIdentity = 'prompt-id' | 'user-message-id'

export type AcpHistoryTurn = {
  /** The agent's id for the turn; null when its replay names none. */
  turn: string | null
  /** The person's message, in the order its chunks came. */
  user: NativeChatBlock[]
  /** The turn's own frames after the person's message, no longer marked as replay. */
  frames: AcpLoadHistoryFrame[]
  /** Every message id the replay gave this turn (OpenCode): the person's and the agent's. */
  messageIds: string[]
  /** When the agent recorded the person's message (Grok), on the agent host's clock. */
  startedAt: number | null
  /** The agent's own end of the turn was replayed. */
  ended: boolean
}

/** A replayed turn under the agent's own id. */
export type AcpIdentifiedHistoryTurn = AcpHistoryTurn & { turn: string }

const sessionSchema = z.object({ sessionId: z.string() })
const looseRecord = z.record(z.string(), z.unknown())
const frameSchema = z.looseObject({
  update: z.looseObject({
    sessionUpdate: z.string(),
    messageId: z.string().optional(),
    prompt_id: z.string().optional(),
    content: z.unknown().optional(),
    _meta: z.looseObject({ promptIndex: z.number().optional() }).optional()
  }),
  _meta: z
    .looseObject({ promptId: z.string().optional(), agentTimestampMs: z.number().optional() })
    .optional()
})
const contentSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
  z.looseObject({ type: z.literal('resource_link'), uri: z.string(), name: z.string().optional() }),
  z.looseObject({
    type: z.literal('resource'),
    resource: z.looseObject({ uri: z.string(), text: z.string().optional() })
  })
])

/** OpenCode names reasoning `<message id>:reasoning:<n>`; the message is what its store keys. */
const REASONING_SUFFIX = /:reasoning:\d+$/

function userBlock(content: unknown): NativeChatBlock | null {
  const parsed = contentSchema.safeParse(content)
  if (!parsed.success) {
    return null
  }
  const block = parsed.data
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return { type: 'image-ref', url: `data:${block.mimeType};base64,${block.data}` }
    case 'resource_link':
      return { type: 'text', text: block.name ?? block.uri }
    case 'resource':
      return { type: 'text', text: block.resource.text ?? block.resource.uri }
  }
}

/** The frame with the agent's replay marking removed, so it reads as the turn it records. */
function unmarked(frame: AcpLoadHistoryFrame): AcpLoadHistoryFrame {
  const params = looseRecord.safeParse(frame.params)
  const meta = params.success ? looseRecord.safeParse(params.data._meta) : null
  if (!params.success || !meta?.success) {
    return frame
  }
  const { isReplay: _isReplay, ...rest } = meta.data
  return { method: frame.method, params: { ...params.data, _meta: rest } }
}

/** The replay's turns in the agent's order. Throws when one turn names two prompt ids. */
export function acpHistoryTurns(
  frames: readonly AcpLoadHistoryFrame[],
  identity: AcpHistoryTurnIdentity
): AcpHistoryTurn[] {
  const turns: AcpHistoryTurn[] = []
  let current: (AcpHistoryTurn & { userKey: string | number | undefined }) | null = null
  const nameTurn = (turn: AcpHistoryTurn, id: string | undefined) => {
    if (id === undefined || id === turn.turn) {
      return
    }
    if (turn.turn !== null) {
      throw new Error('conflicting-history-turn')
    }
    turn.turn = id
  }
  for (const frame of frames) {
    const parsed = frameSchema.safeParse(frame.params)
    if (!parsed.success) {
      current?.frames.push(unmarked(frame))
      continue
    }
    const { update, _meta: meta } = parsed.data
    if (update.sessionUpdate === 'user_message_chunk') {
      const userKey = identity === 'user-message-id' ? update.messageId : update._meta?.promptIndex
      if (!current || current.frames.length > 0 || current.userKey !== userKey) {
        current = {
          turn: null,
          user: [],
          frames: [],
          messageIds: [],
          startedAt: meta?.agentTimestampMs ?? null,
          ended: false,
          userKey
        }
        turns.push(current)
        if (identity === 'user-message-id') {
          nameTurn(current, update.messageId)
        }
      }
      const block = userBlock(update.content)
      if (block) {
        current.user.push(block)
      }
    } else if (current) {
      current.frames.push(unmarked(frame))
      if (identity === 'prompt-id') {
        nameTurn(current, meta?.promptId)
        if (update.sessionUpdate === 'turn_completed') {
          nameTurn(current, update.prompt_id)
          current.ended = true
        }
      }
    } else {
      continue
    }
    if (identity === 'user-message-id' && update.messageId) {
      const id = update.messageId.replace(REASONING_SUFFIX, '')
      if (!current.messageIds.includes(id)) {
        current.messageIds.push(id)
      }
    }
  }
  return turns.map(({ userKey: _userKey, ...turn }) => turn)
}
