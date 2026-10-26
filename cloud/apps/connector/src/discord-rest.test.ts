import { describe, expect, it } from 'vitest'
import { createDiscordRestApi, discordRoutes } from './discord-rest.js'

// Headers and the 429 body follow https://docs.discord.com/developers/topics/rate-limits; routes
// follow https://docs.discord.com/developers/resources/message and
// https://docs.discord.com/developers/interactions/receiving-and-responding.
type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

function fakeDiscord(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    const reply = replies.shift() ?? { status: 200, body: {} }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers
    })
  }
  return { calls, request }
}

const limited = (remaining: string, resetAfter: string, bucket = 'abcd') => ({
  'x-ratelimit-bucket': bucket,
  'x-ratelimit-limit': '5',
  'x-ratelimit-remaining': remaining,
  'x-ratelimit-reset-after': resetAfter
})

describe('createDiscordRestApi', () => {
  it('sends each route with the bot token and no mentions', async () => {
    const discord = fakeDiscord([
      { status: 201, body: { id: 'T1' } },
      { status: 200, body: { id: 'M2' } },
      { status: 200, body: { id: 'M2' } },
      { status: 204 },
      { status: 200, body: { id: 'F1' } }
    ])
    const api = createDiscordRestApi(discord.request)
    expect(await api('bot', discordRoutes.startThread('C1', 'M1', 'Fix the build'))).toEqual({
      kind: 'ok',
      body: { id: 'T1' }
    })
    await api('bot', discordRoutes.createMessage('T1', { content: 'Working' }))
    await api('bot', discordRoutes.editMessage('T1', 'M2', { content: 'Done' }))
    expect(await api('bot', discordRoutes.addReaction('C1', 'M1', '👀'))).toEqual({
      kind: 'ok',
      body: {}
    })
    await api('bot', discordRoutes.ephemeralFollowup('A1', 'itok', 'Only the owner can answer'))
    expect(discord.calls.map(({ url, init }) => [init.method, url])).toEqual([
      ['POST', 'https://discord.com/api/v10/channels/C1/messages/M1/threads'],
      ['POST', 'https://discord.com/api/v10/channels/T1/messages'],
      ['PATCH', 'https://discord.com/api/v10/channels/T1/messages/M2'],
      ['PUT', 'https://discord.com/api/v10/channels/C1/messages/M1/reactions/%F0%9F%91%80/@me'],
      ['POST', 'https://discord.com/api/v10/webhooks/A1/itok']
    ])
    expect(discord.calls[1]?.init.headers).toEqual({
      authorization: 'Bot bot',
      'content-type': 'application/json'
    })
    expect(JSON.parse(String(discord.calls[1]?.init.body))).toEqual({
      content: 'Working',
      allowed_mentions: { parse: [] }
    })
    expect(discord.calls[4]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(discord.calls[4]?.init.body))).toMatchObject({ flags: 64 })
  })

  it('holds a spent bucket until it resets, per channel', async () => {
    let now = 1_000_000
    const discord = fakeDiscord([{ status: 200, body: { id: 'M' }, headers: limited('0', '1.5') }])
    const api = createDiscordRestApi(discord.request, () => now)
    await api('bot', discordRoutes.createMessage('C1', { content: 'a' }))
    expect(await api('bot', discordRoutes.createMessage('C1', { content: 'b' }))).toEqual({
      kind: 'retry',
      afterMs: 1500
    })
    // Another channel counts separately; the hold never reached Discord.
    await api('bot', discordRoutes.createMessage('C2', { content: 'c' }))
    expect(discord.calls).toHaveLength(2)
    now += 1500
    await api('bot', discordRoutes.createMessage('C1', { content: 'd' }))
    expect(discord.calls).toHaveLength(3)
  })

  it('shares a learned bucket between routes on the same channel', async () => {
    const now = 1_000_000
    const discord = fakeDiscord([
      { status: 200, body: {}, headers: limited('1', '2', 'shared') },
      { status: 200, body: {}, headers: limited('0', '2', 'shared') }
    ])
    const api = createDiscordRestApi(discord.request, () => now)
    await api('bot', discordRoutes.createMessage('C1', { content: 'a' }))
    await api('bot', discordRoutes.editMessage('C1', 'M', { content: 'b' }))
    expect(await api('bot', discordRoutes.createMessage('C1', { content: 'c' }))).toEqual({
      kind: 'retry',
      afterMs: 2000
    })
  })

  it('turns a 429 into retry after retry_after, holding the bucket or every route when global', async () => {
    let now = 1_000_000
    const discord = fakeDiscord([
      {
        status: 429,
        body: { message: 'You are being rate limited.', retry_after: 0.25, global: false }
      },
      {
        status: 429,
        body: { message: 'You are being rate limited.', retry_after: 2, global: true },
        headers: { 'x-ratelimit-global': 'true' }
      }
    ])
    const api = createDiscordRestApi(discord.request, () => now)
    const react = discordRoutes.addReaction('C1', 'M1', '✅')
    expect(await api('bot', react)).toEqual({ kind: 'retry', afterMs: 250 })
    expect(await api('bot', react)).toEqual({ kind: 'retry', afterMs: 250 })
    expect(await api('bot', discordRoutes.createMessage('C9', { content: 'a' }))).toEqual({
      kind: 'retry',
      afterMs: 2000
    })
    now += 1000
    expect(await api('bot', discordRoutes.createMessage('C8', { content: 'b' }))).toEqual({
      kind: 'retry',
      afterMs: 1000
    })
    // Interaction followups are exempt from the global limit.
    await api('bot', discordRoutes.ephemeralFollowup('A1', 'itok', 'x'))
    expect(discord.calls).toHaveLength(3)
  })

  it('keeps under 50 requests a second', async () => {
    let now = 1_000_200
    const api = createDiscordRestApi(fakeDiscord([]).request, () => now)
    for (let index = 0; index < 50; index++) {
      expect(
        (await api('bot', discordRoutes.createMessage(`C${index}`, { content: 'a' }))).kind
      ).toBe('ok')
    }
    expect(await api('bot', discordRoutes.createMessage('C50', { content: 'a' }))).toEqual({
      kind: 'retry',
      afterMs: 800
    })
    now += 800
    expect((await api('bot', discordRoutes.createMessage('C50', { content: 'a' }))).kind).toBe('ok')
  })

  it('reads errors as failed, server errors and network failures as unknown', async () => {
    const discord = fakeDiscord([
      { status: 403, body: { code: 50001, message: 'Missing Access' } },
      { status: 404, body: null },
      { status: 502 }
    ])
    const api = createDiscordRestApi(discord.request)
    const route = discordRoutes.createMessage('C1', { content: 'a' })
    expect(await api('bot', route)).toEqual({ kind: 'failed', error: '50001' })
    expect(await api('bot', route)).toEqual({ kind: 'failed', error: 'http_404' })
    expect(await api('bot', route)).toEqual({ kind: 'unknown' })
    const offline = createDiscordRestApi(async () => {
      throw new Error('offline')
    })
    expect(await offline('bot', route)).toEqual({ kind: 'unknown' })
  })
})
