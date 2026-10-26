import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { z } from 'zod'
import {
  DiscordGateway,
  discordPromptText,
  readDiscordMessage,
  type DiscordMessage
} from './discord-gateway.js'

// Payloads follow https://docs.discord.com/developers/events/gateway (Hello, Identify, Ready,
// Resume, Reconnect, Invalid Session), close codes from
// https://docs.discord.com/developers/topics/opcodes-and-status-codes and the message object from
// https://docs.discord.com/developers/resources/message.
const BOT = '1200000000000000000'
const OWNER = '900000000000000000'

const FrameSchema = z.object({ op: z.number(), d: z.unknown() })
type Frame = z.infer<typeof FrameSchema>
const readFrame = (data: unknown): Frame => FrameSchema.parse(JSON.parse(String(data)))

// A fake gateway: each connection records its path and frames; the test drives the replies.
class Connection {
  private readonly frames: Frame[] = []
  private waiting: ((frame: Frame) => void) | undefined
  closeCode: number | undefined
  readonly closed: Promise<number>

  constructor(
    readonly socket: ServerSocket,
    readonly path: string
  ) {
    socket.on('message', (data) => {
      const frame = readFrame(data)
      const waiting = this.waiting
      this.waiting = undefined
      if (waiting) {
        waiting(frame)
      } else {
        this.frames.push(frame)
      }
    })
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  }

  // The next frame other than a heartbeat, which is acknowledged.
  async next(): Promise<Frame> {
    for (;;) {
      const frame =
        this.frames.shift() ?? (await new Promise<Frame>((resolve) => (this.waiting = resolve)))
      if (frame.op !== 1) {
        return frame
      }
      this.send({ op: 11 })
    }
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload))
  }

  hello(intervalMs = 60_000): void {
    this.send({ op: 10, d: { heartbeat_interval: intervalMs } })
  }
}

let server: WebSocketServer | undefined
let gateway: DiscordGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  const closing = server
  if (closing) {
    await new Promise((resolve) => closing.close(resolve))
  }
  gateway = undefined
  server = undefined
})

async function startGateway(
  options: { ownsThread?: (channelId: string) => Promise<boolean> } = {}
) {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => server?.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  const origin = `ws://127.0.0.1:${address.port}`
  const connections: Connection[] = []
  let arrived: ((connection: Connection) => void) | undefined
  server.on('connection', (socket, request) => {
    const connection = new Connection(socket, request.url ?? '')
    const waiting = arrived
    arrived = undefined
    if (waiting) {
      waiting(connection)
    } else {
      connections.push(connection)
    }
  })
  const nextConnection = async () =>
    connections.shift() ?? (await new Promise<Connection>((resolve) => (arrived = resolve)))
  const messages: DiscordMessage[] = []
  const fatal: number[] = []
  gateway = new DiscordGateway({
    token: 'bot-token',
    url: `${origin}/`,
    ownsThread: options.ownsThread ?? (async () => false),
    onMessage: async (message) => {
      messages.push(message)
    },
    onFatal: (code) => fatal.push(code),
    random: () => 0
  })
  gateway.start()
  return { origin, nextConnection, messages, fatal }
}

const ready = (origin: string, seq = 1) => ({
  op: 0,
  s: seq,
  t: 'READY',
  d: {
    v: 10,
    user: { id: BOT, username: 'Orca', bot: true },
    guilds: [],
    session_id: 'session-1',
    resume_gateway_url: `${origin}/resume`
  }
})

const messageCreate = (seq: number, overrides: Record<string, unknown>) => ({
  op: 0,
  s: seq,
  t: 'MESSAGE_CREATE',
  d: {
    id: `m${seq}`,
    channel_id: 'C1',
    guild_id: 'G1',
    author: { id: OWNER, username: 'owner' },
    content: 'hello',
    mentions: [],
    mention_roles: [],
    type: 0,
    ...overrides
  }
})

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check() && tries < 200; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(check()).toBe(true)
}

async function identified(origin: string, nextConnection: () => Promise<Connection>) {
  const connection = await nextConnection()
  connection.hello()
  const identify = await connection.next()
  connection.send(ready(origin))
  return { connection, identify }
}

describe('DiscordGateway', () => {
  it('identifies with our intents and passes on mentions and owned-thread messages in order', async () => {
    const { origin, nextConnection, messages } = await startGateway({
      ownsThread: async (channelId) => channelId === 'T1'
    })
    const { connection, identify } = await identified(origin, nextConnection)
    expect(connection.path).toBe('/?v=10&encoding=json')
    expect(identify).toEqual({
      op: 2,
      d: {
        token: 'bot-token',
        intents: 33281,
        properties: { os: process.platform, browser: 'orca-connector', device: 'orca-connector' }
      }
    })
    connection.send(
      messageCreate(2, { content: `<@${BOT}> fix the build`, mentions: [{ id: BOT }] })
    )
    connection.send(messageCreate(3, { content: 'unrelated' }))
    connection.send(messageCreate(4, { channel_id: 'T1', content: 'also check CI', type: 19 }))
    connection.send(messageCreate(5, { channel_id: 'T1', author: { id: 'B2', bot: true } }))
    connection.send(messageCreate(6, { channel_id: 'T1', author: { id: BOT } }))
    connection.send(messageCreate(7, { channel_id: 'T1', type: 18 }))
    connection.send(messageCreate(8, { channel_id: 'T1', webhook_id: 'W1' }))
    connection.send(messageCreate(9, { channel_id: 'T1', content: 'last' }))
    await until(() => messages.length === 3)
    expect(messages).toEqual([
      {
        guildId: 'G1',
        channelId: 'C1',
        messageId: 'm2',
        userId: OWNER,
        content: `<@${BOT}> fix the build`,
        mentioned: true
      },
      {
        guildId: 'G1',
        channelId: 'T1',
        messageId: 'm4',
        userId: OWNER,
        content: 'also check CI',
        mentioned: false
      },
      {
        guildId: 'G1',
        channelId: 'T1',
        messageId: 'm9',
        userId: OWNER,
        content: 'last',
        mentioned: false
      }
    ])
  })

  it('heartbeats with the last sequence and answers a heartbeat request at once', async () => {
    const { origin, nextConnection } = await startGateway()
    const connection = await nextConnection()
    const beats: unknown[] = []
    connection.socket.on('message', (data) => {
      const frame = readFrame(data)
      if (frame.op === 1) {
        beats.push(frame.d)
        connection.send({ op: 11 })
      }
    })
    connection.hello(40)
    await until(() => beats.length >= 1)
    expect(beats[0]).toBeNull()
    connection.send(ready(origin, 5))
    connection.send({ op: 1, d: null })
    await until(() => beats.includes(5))
  })

  it('resumes at the resume URL after Reconnect, and after a missed heartbeat ack', async () => {
    const { origin, nextConnection } = await startGateway()
    const { connection } = await identified(origin, nextConnection)
    connection.send(messageCreate(7, {}))
    connection.send({ op: 7, d: null })
    expect(await connection.closed).toBe(4000)
    const second = await nextConnection()
    expect(second.path).toBe('/resume?v=10&encoding=json')
    second.hello()
    expect(await second.next()).toEqual({
      op: 6,
      d: { token: 'bot-token', session_id: 'session-1', seq: 7 }
    })
    second.send({ op: 0, s: 8, t: 'RESUMED', d: null })
    // A connection that never acknowledges a beat is dropped and resumed.
    second.socket.removeAllListeners('message')
    second.hello(40)
    expect(await second.closed).toBe(4000)
    const third = await nextConnection()
    third.hello()
    expect(await third.next()).toMatchObject({ op: 6, d: { session_id: 'session-1', seq: 8 } })
  })

  it('identifies afresh after Invalid Session (false) or a session-ending close', async () => {
    const { origin, nextConnection } = await startGateway()
    const { connection } = await identified(origin, nextConnection)
    connection.send({ op: 9, d: false })
    const second = await nextConnection()
    expect(second.path).toBe('/?v=10&encoding=json')
    second.hello()
    expect(await second.next()).toMatchObject({ op: 2 })
    second.send(ready(origin))
    second.socket.close(4009)
    const third = await nextConnection()
    third.hello()
    expect(await third.next()).toMatchObject({ op: 2 })
  })

  it('stops for good when Discord refuses the token or intents', async () => {
    const { origin, nextConnection, fatal } = await startGateway()
    const { connection } = await identified(origin, nextConnection)
    connection.socket.close(4014)
    await until(() => fatal.length === 1)
    expect(fatal).toEqual([4014])
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(server?.clients.size).toBe(0)
  })

  it('ends the session with 1000 on stop', async () => {
    const { origin, nextConnection } = await startGateway()
    const { connection } = await identified(origin, nextConnection)
    await gateway?.stop()
    expect(await connection.closed).toBe(1000)
  })
})

describe('readDiscordMessage', () => {
  it('ignores direct messages and malformed payloads', () => {
    const { guild_id: _guild, ...dm } = messageCreate(1, {}).d
    expect(readDiscordMessage(dm, BOT)).toBeNull()
    expect(readDiscordMessage({ id: '1' }, BOT)).toBeNull()
  })
})

describe('discordPromptText', () => {
  it('drops the bot mention in either form', () => {
    expect(discordPromptText(`<@${BOT}> fix <@!${BOT}> it <@${OWNER}>`, BOT)).toBe(
      `fix  it <@${OWNER}>`
    )
  })
})
