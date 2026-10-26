import { z } from 'zod'
import { discordPromptText } from './discord-text.js'

// Gateway dispatch shapes: https://docs.discord.com/developers/events/gateway-events and the
// message object in https://docs.discord.com/developers/resources/message.
const MessageCreateSchema = z.looseObject({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  author: z.looseObject({
    id: z.string().min(1),
    bot: z.boolean().optional(),
    username: z.string().optional(),
    global_name: z.string().nullish()
  }),
  member: z.looseObject({ nick: z.string().nullish() }).optional(),
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
  // The server nickname, else the display name, else the username.
  userName: string
  // What the agent reads: the bot's mention dropped.
  text: string
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
    userName:
      message.member?.nick ||
      message.author.global_name ||
      message.author.username ||
      message.author.id,
    text: discordPromptText(message.content, botUserId),
    mentioned: message.mentions.some((user) => user.id === botUserId)
  }
}

const ThreadSchema = z.looseObject({ id: z.string().min(1), parent_id: z.string().min(1) })
const ChannelSchema = z.looseObject({
  id: z.string().min(1),
  type: z.number().int(),
  parent_id: z.string().nullable().optional()
})
// Announcement, public and private threads; https://docs.discord.com/developers/resources/channel
const THREAD_TYPES = new Set([10, 11, 12])
const ThreadsSchema = z.looseObject({ threads: z.array(z.unknown()).default([]) })
const DeletedSchema = z.looseObject({ id: z.string().min(1) })
const MAX_THREADS = 10_000

// Which parent channel each thread sits in (null: the channel is not a thread). The gateway's
// thread events fill it; a resumed session replays no guild state, so a miss is looked up once.
export class DiscordThreadParents {
  private readonly parents = new Map<string, string | null>()

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

  // undefined: not known yet.
  parentOf(channelId: string): string | null | undefined {
    return this.parents.get(channelId)
  }

  // A channel object from GET /channels/{id}.
  learnChannel(payload: unknown): void {
    const channel = ChannelSchema.safeParse(payload)
    if (channel.success) {
      const { id, type, parent_id: parentId } = channel.data
      this.set(id, THREAD_TYPES.has(type) && parentId ? parentId : null)
    }
  }

  private remember(payload: unknown): void {
    const thread = ThreadSchema.safeParse(payload)
    if (thread.success) {
      this.set(thread.data.id, thread.data.parent_id)
    }
  }

  private set(channelId: string, parentId: string | null): void {
    // Re-inserting keeps recency order, so the oldest channel is forgotten first.
    this.parents.delete(channelId)
    this.parents.set(channelId, parentId)
    if (this.parents.size > MAX_THREADS) {
      const oldest = this.parents.keys().next().value
      if (oldest !== undefined) {
        this.parents.delete(oldest)
      }
    }
  }
}
