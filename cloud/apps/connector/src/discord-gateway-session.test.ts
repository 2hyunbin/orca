import { createServer, type Server } from 'node:http'
import { REST } from '@discordjs/rest'
import type { SessionInfo } from '@discordjs/ws'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { z } from 'zod'
import {
  startDiscordGatewaySession,
  type DiscordGatewayMessage,
  type DiscordGatewaySession
} from './discord-gateway-session.js'

// A fake Discord: GET /gateway/bot and /users/@me over HTTP, and a gateway speaking the payloads in
// https://docs.discord.com/developers/events/gateway (Hello, Identify, Ready, Dispatch, Resume)
// with close codes from https://docs.discord.com/developers/topics/opcodes-and-status-codes.
const BOT = '1200000000000000000'
const OWNER = '900000000000000000'
const FrameSchema = z.object({ op: z.number(), d: z.unknown() })
type Frame = z.infer<typeof FrameSchema>

class Connection {
  private readonly frames: Frame[] = []
  private waiting: ((frame: Frame) => void) | undefined
  readonly closed: Promise<number>

  constructor(
    readonly socket: ServerSocket,
    readonly path: string
  ) {
    socket.on('message', (data) => {
      const frame = FrameSchema.parse(JSON.parse(String(data)))
      const waiting = this.waiting
      this.waiting = undefined
      if (waiting) {
        waiting(frame)
      } else {
        this.frames.push(frame)
      }
    })
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
    this.send({ op: 10, d: { heartbeat_interval: 60_000 } })
  }

  // The next frame other than a heartbeat.
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
}

let http: Server | undefined
let gateway: WebSocketServer | undefined
// Starting resolves once the gateway is ready, so tests drive the fake while it is pending.
let session: Promise<DiscordGatewaySession> | undefined

afterEach(async () => {
  for (const client of gateway?.clients ?? []) {
    client.close(4004)
  }
  await (await session?.catch(() => undefined))?.handOver().catch(() => undefined)
  for (const client of gateway?.clients ?? []) {
    client.terminate()
  }
  await new Promise((resolve) => gateway?.close(resolve) ?? resolve(undefined))
  await new Promise((resolve) => http?.close(resolve) ?? resolve(undefined))
  session = undefined
})

async function fakeDiscord() {
  const requested: string[] = []
  // Channel objects: https://docs.discord.com/developers/resources/channel
  const channels: Record<string, unknown> = {
    '/api/v10/channels/C1': { id: 'C1', type: 0, guild_id: 'G1' },
    '/api/v10/channels/T7': { id: 'T7', type: 11, guild_id: 'G1', parent_id: 'C7' }
  }
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    requested.push(url)
    response.setHeader('content-type', 'application/json')
    const gatewayBot = {
      url: origin,
      shards: 1,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 }
    }
    const me = { id: BOT, username: 'Orca', bot: true }
    response.end(JSON.stringify(url === '/api/v10/users/@me' ? me : (channels[url] ?? gatewayBot)))
  })
  http = server
  gateway = new WebSocketServer({ server })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  const origin = `ws://127.0.0.1:${address.port}`
  const connections: Connection[] = []
  let arrived: ((connection: Connection) => void) | undefined
  gateway.on('connection', (socket, request) => {
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
  return {
    origin,
    nextConnection,
    requested,
    rest: new REST({ api: `http://127.0.0.1:${address.port}/api` })
  }
}

async function start(
  options: {
    stored?: (origin: string) => SessionInfo
    ownsThread?: (id: string) => Promise<boolean>
  } = {}
) {
  const discord = await fakeDiscord()
  const messages: DiscordGatewayMessage[] = []
  const saved: (SessionInfo | null)[] = []
  const fatal: number[] = []
  session = startDiscordGatewaySession({
    token: 'bot-token',
    rest: discord.rest,
    store: {
      load: async () => options.stored?.(discord.origin) ?? null,
      save: async (info) => void saved.push(info)
    },
    ownsThread: options.ownsThread ?? (async () => false),
    onMessage: async (message) => void messages.push(message),
    onFatal: (code) => fatal.push(code)
  })
  // A refused start rejects; the test reads that through onFatal.
  session.catch(() => undefined)
  return { ...discord, messages, saved, fatal }
}

const ready = (origin: string) => ({
  op: 0,
  s: 1,
  t: 'READY',
  d: {
    v: 10,
    user: { id: BOT, username: 'Orca', bot: true },
    guilds: [],
    session_id: 'session-1',
    resume_gateway_url: `${origin}/resume`,
    shard: [0, 1],
    application: { id: BOT, flags: 0 }
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
  for (let tries = 0; !check() && tries < 300; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(check()).toBe(true)
}

describe('startDiscordGatewaySession', () => {
  it('identifies with our intents and passes on mentions and owned-thread messages in order', async () => {
    const { origin, nextConnection, messages } = await start({
      ownsThread: async (channelId) => channelId === 'T1'
    })
    const connection = await nextConnection()
    expect(connection.path).toBe('/?v=10&encoding=json')
    expect(await connection.next()).toMatchObject({
      op: 2,
      d: {
        token: 'bot-token',
        intents: 33281,
        properties: { os: process.platform, browser: 'orca-connector', device: 'orca-connector' }
      }
    })
    connection.send(ready(origin))
    connection.send({ op: 0, s: 2, t: 'THREAD_CREATE', d: { id: 'T1', parent_id: 'C1', type: 11 } })
    connection.send(
      messageCreate(3, { content: `<@${BOT}> fix the build`, mentions: [{ id: BOT }] })
    )
    connection.send(messageCreate(4, { content: 'unrelated' }))
    connection.send(messageCreate(5, { channel_id: 'T1', content: 'also check CI', type: 19 }))
    connection.send(messageCreate(6, { channel_id: 'T1', author: { id: 'B2', bot: true } }))
    connection.send(messageCreate(7, { channel_id: 'T1', author: { id: BOT } }))
    connection.send(messageCreate(8, { channel_id: 'T1', type: 18 }))
    connection.send(messageCreate(9, { channel_id: 'T1', webhook_id: 'W1' }))
    connection.send(messageCreate(10, { channel_id: 'T1', content: 'last' }))
    await until(() => messages.length === 3)
    const base = { guildId: 'G1', userId: OWNER, mentioned: false }
    expect(messages).toEqual([
      {
        ...base,
        channelId: 'C1',
        messageId: 'm3',
        content: `<@${BOT}> fix the build`,
        mentioned: true
      },
      { ...base, channelId: 'T1', messageId: 'm5', content: 'also check CI', threadParentId: 'C1' },
      { ...base, channelId: 'T1', messageId: 'm10', content: 'last', threadParentId: 'C1' }
    ])
  })

  it('looks up an unknown mention channel once, so a thread mention after a resume has its parent', async () => {
    const { origin, nextConnection, messages, requested } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.send(ready(origin))
    const mention = { mentions: [{ id: BOT }] }
    connection.send(messageCreate(2, { ...mention, channel_id: 'T7' }))
    connection.send(messageCreate(3, { ...mention, channel_id: 'T7' }))
    connection.send(messageCreate(4, mention))
    connection.send(messageCreate(5, mention))
    await until(() => messages.length === 4)
    expect(messages.map((message) => message.threadParentId)).toEqual([
      'C7',
      'C7',
      undefined,
      undefined
    ])
    expect(requested.filter((url) => url.startsWith('/api/v10/channels/'))).toEqual([
      '/api/v10/channels/T7',
      '/api/v10/channels/C1'
    ])
  })

  it('hands over: closes resumably and saves the session for the next leader', async () => {
    const { origin, nextConnection, saved } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.send(ready(origin))
    connection.send(messageCreate(3, {}))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await (await session)?.handOver()
    session = undefined
    expect(await connection.closed).toBe(4200)
    expect(saved.at(-1)).toMatchObject({
      sessionId: 'session-1',
      sequence: 3,
      resumeURL: `${origin}/resume`
    })
  })

  it('resumes a stored session at its resume URL', async () => {
    const { nextConnection } = await start({
      stored: (origin) => ({
        sessionId: 'session-1',
        sequence: 7,
        resumeURL: `${origin}/resume`,
        shardId: 0,
        shardCount: 1
      })
    })
    const connection = await nextConnection()
    expect(connection.path).toBe('/resume?v=10&encoding=json')
    expect(await connection.next()).toEqual({
      op: 6,
      d: { token: 'bot-token', session_id: 'session-1', seq: 7 }
    })
  })

  it('reports a refused token as fatal', async () => {
    const { nextConnection, fatal } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.socket.close(4004)
    await until(() => fatal.length === 1)
    expect(fatal).toEqual([4004])
  })
})
