import { z } from 'zod'

// Gateway dispatch shapes: https://docs.discord.com/developers/events/gateway-events and the
// message object in https://docs.discord.com/developers/resources/message.
const MessageCreateSchema = z.looseObject({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  author: z.looseObject({ id: z.string().min(1), bot: z.boolean().optional() }),
  content: z.string(),
  mentions: z.array(z.looseObject({ id: z.string() })).default([]),
  type: z.number().int(),
  webhook_id: z.string().optional()
})
// DEFAULT and REPLY; joins, pins, thread notices and command echoes are not a person's message.
const PERSON_MESSAGE_TYPES = new Set([0, 19])

export type DiscordMessage = {
  guildId: string
  channelId: string
  messageId: string
  userId: string
  content: string
  mentioned: boolean
}

// A guild member's message, or null for DMs, bots, webhooks, ourselves and system messages.
export function readDiscordMessage(payload: unknown, botUserId: string): DiscordMessage | null {
  const parsed = MessageCreateSchema.safeParse(payload)
  if (!parsed.success) {
    return null
  }
  const message = parsed.data
  if (
    message.guild_id === undefined ||
    message.author.bot === true ||
    message.webhook_id !== undefined ||
    message.author.id === botUserId ||
    !PERSON_MESSAGE_TYPES.has(message.type)
  ) {
    return null
  }
  return {
    guildId: message.guild_id,
    channelId: message.channel_id,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    mentioned: message.mentions.some((user) => user.id === botUserId)
  }
}

const ThreadSchema = z.looseObject({ id: z.string().min(1), parent_id: z.string().min(1) })
const ThreadsSchema = z.looseObject({ threads: z.array(z.unknown()).default([]) })
const DeletedSchema = z.looseObject({ id: z.string().min(1) })
const MAX_THREADS = 10_000

// Which parent channel each thread the gateway has told us about sits in. Only threads active
// since this process connected are known (a resumed session replays no guild state).
export class DiscordThreadParents {
  private readonly parents = new Map<string, string>()

  apply(type: string, payload: unknown): void {
    if (type === 'THREAD_DELETE') {
      const deleted = DeletedSchema.safeParse(payload)
      if (deleted.success) {
        this.parents.delete(deleted.data.id)
      }
      return
    }
    if (type === 'THREAD_CREATE' || type === 'THREAD_UPDATE') {
      this.remember(payload)
      return
    }
    if (type === 'GUILD_CREATE' || type === 'THREAD_LIST_SYNC') {
      const list = ThreadsSchema.safeParse(payload)
      for (const thread of list.success ? list.data.threads : []) {
        this.remember(thread)
      }
    }
  }

  parentOf(channelId: string): string | undefined {
    return this.parents.get(channelId)
  }

  private remember(payload: unknown): void {
    const thread = ThreadSchema.safeParse(payload)
    if (!thread.success) {
      return
    }
    // Re-inserting keeps recency order, so the oldest thread is forgotten first.
    this.parents.delete(thread.data.id)
    this.parents.set(thread.data.id, thread.data.parent_id)
    if (this.parents.size > MAX_THREADS) {
      const oldest = this.parents.keys().next().value
      if (oldest !== undefined) {
        this.parents.delete(oldest)
      }
    }
  }
}
