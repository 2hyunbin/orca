import { z } from 'zod'

// https://docs.discord.com/developers/events/gateway and
// https://docs.discord.com/developers/topics/opcodes-and-status-codes
const GATEWAY_QUERY = '?v=10&encoding=json'
const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11
} as const
// GUILDS (thread events), GUILD_MESSAGES, MESSAGE_CONTENT (privileged).
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)
// Bad token, shard, version or intents: reconnecting can't help.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
// Invalid seq and session timeout: reconnect with a new session.
const SESSION_ENDED_CLOSE_CODES = new Set([4007, 4009])
// Any code but 1000/1001 keeps the session resumable.
const RESUMABLE_CLOSE = 4000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000

const PayloadSchema = z.looseObject({
  op: z.number().int(),
  d: z.unknown(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional()
})
const HelloSchema = z.looseObject({ heartbeat_interval: z.number().positive() })
const ReadySchema = z.looseObject({
  session_id: z.string().min(1),
  resume_gateway_url: z.string().min(1),
  user: z.looseObject({ id: z.string().min(1) })
})
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

// A guild member's message, or null for bots, webhooks, ourselves and system messages.
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

// What the agent reads: mentions of the bot (<@id>, or the older <@!id>) dropped.
export function discordPromptText(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim()
}

export type DiscordGatewayDeps = {
  token: string
  // wss://gateway.discord.gg, or a test server.
  url: string
  // Whether a channel is a thread the connector started; asked only for messages without a mention.
  ownsThread: (channelId: string) => Promise<boolean>
  // Called in arrival order, one at a time; the gateway won't send the message again.
  onMessage: (message: DiscordMessage) => Promise<void>
  // Discord refused the token, intents or version; the caller should stop and alert.
  onFatal: (closeCode: number) => void
  random?: () => number
}

type Session = { id: string; resumeUrl: string }

// One gateway connection: Identify once, Resume after every drop the session survives.
export class DiscordGateway {
  private socket: WebSocket | null = null
  private session: Session | null = null
  private seq: number | null = null
  private botUserId: string | null = null
  private heartbeat: NodeJS.Timeout | undefined
  private reconnect: NodeJS.Timeout | undefined
  private acked = true
  private reconnectMs = RECONNECT_BASE_MS
  private stopped = false
  private delivery: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DiscordGatewayDeps) {}

  start(): void {
    this.connect()
  }

  // Ends the session (close 1000), so the next leader identifies afresh.
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.reconnect)
    clearInterval(this.heartbeat)
    this.socket?.close(1000)
    await this.delivery
  }

  private connect(): void {
    const url = `${this.session?.resumeUrl ?? this.deps.url}${GATEWAY_QUERY}`
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('message', (event) => {
      if (this.socket === socket && typeof event.data === 'string') {
        this.receive(event.data)
      }
    })
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) {
        this.closed(event.code)
      }
    })
  }

  private send(op: number, d: unknown): void {
    this.socket?.send(JSON.stringify({ op, d }))
  }

  // Drops this socket and connects again after the backoff, resuming unless the session ended.
  private drop(sessionEnded: boolean): void {
    const socket = this.socket
    this.socket = null
    clearInterval(this.heartbeat)
    socket?.close(RESUMABLE_CLOSE)
    if (sessionEnded) {
      this.session = null
    }
    if (this.stopped) {
      return
    }
    const random = this.deps.random ?? Math.random
    const delayMs = this.reconnectMs * (0.5 + random() / 2)
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS)
    this.reconnect = setTimeout(() => this.connect(), delayMs)
  }

  private closed(code: number): void {
    if (FATAL_CLOSE_CODES.has(code)) {
      this.stopped = true
      this.socket = null
      clearInterval(this.heartbeat)
      clearTimeout(this.reconnect)
      console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fatal', code }))
      this.deps.onFatal(code)
      return
    }
    this.drop(SESSION_ENDED_CLOSE_CODES.has(code))
  }

  private receive(data: string): void {
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    const payload = PayloadSchema.safeParse(json)
    if (!payload.success) {
      return
    }
    const { op, d, s, t } = payload.data
    switch (op) {
      case OP.hello:
        this.hello(d)
        return
      case OP.heartbeat:
        this.send(OP.heartbeat, this.seq)
        return
      case OP.heartbeatAck:
        this.acked = true
        return
      case OP.reconnect:
        this.drop(false)
        return
      case OP.invalidSession:
        this.drop(d !== true)
        return
      case OP.dispatch:
        if (typeof s === 'number') {
          this.seq = s
        }
        this.dispatch(t ?? '', d)
    }
  }

  private hello(d: unknown): void {
    const hello = HelloSchema.safeParse(d)
    if (!hello.success) {
      this.drop(false)
      return
    }
    const intervalMs = hello.data.heartbeat_interval
    const random = this.deps.random ?? Math.random
    this.acked = true
    clearInterval(this.heartbeat)
    // The first beat waits a random fraction of the interval.
    this.heartbeat = setTimeout(() => {
      this.beat()
      this.heartbeat = setInterval(() => this.beat(), intervalMs)
    }, intervalMs * random())
    if (this.session) {
      this.send(OP.resume, { token: this.deps.token, session_id: this.session.id, seq: this.seq })
      return
    }
    this.seq = null
    this.send(OP.identify, {
      token: this.deps.token,
      intents: DISCORD_GATEWAY_INTENTS,
      properties: { os: process.platform, browser: 'orca-connector', device: 'orca-connector' }
    })
  }

  // No acknowledgement since the last beat means a dead connection.
  private beat(): void {
    if (!this.acked) {
      this.drop(false)
      return
    }
    this.acked = false
    this.send(OP.heartbeat, this.seq)
  }

  private dispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      const ready = ReadySchema.safeParse(d)
      if (ready.success) {
        this.botUserId = ready.data.user.id
        this.session = { id: ready.data.session_id, resumeUrl: ready.data.resume_gateway_url }
        this.reconnectMs = RECONNECT_BASE_MS
      }
      return
    }
    if (type === 'RESUMED') {
      this.reconnectMs = RECONNECT_BASE_MS
      return
    }
    if (type !== 'MESSAGE_CREATE' || this.botUserId === null) {
      return
    }
    const message = readDiscordMessage(d, this.botUserId)
    if (message === null) {
      return
    }
    this.delivery = this.delivery
      .then(async () => {
        if (message.mentioned || (await this.deps.ownsThread(message.channelId))) {
          await this.deps.onMessage(message)
        }
      })
      .catch(() => {
        console.warn(JSON.stringify({ event: 'orca_connector_discord_message_dropped' }))
      })
  }
}
