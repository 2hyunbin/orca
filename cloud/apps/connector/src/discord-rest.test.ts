import { describe, expect, it } from 'vitest'
import {
  createDiscordRestApi,
  discordNonce,
  discordRoutes,
  nonceStillDedupes
} from './discord-rest.js'

// Routes and bodies follow https://docs.discord.com/developers/resources/message (create with
// nonce + enforce_nonce, message_reference, allowed_mentions, reactions, history),
// and the 429 body in
// https://docs.discord.com/developers/topics/rate-limits.
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
  const sentBody = (index: number): unknown => JSON.parse(String(calls[index]?.init.body))
  return { calls, request, sentBody }
}

describe('createDiscordRestApi', () => {
  it('sends each route with the bot token', async () => {
    const discord = fakeDiscord([
      { status: 201, body: { id: 'T1' } },
      { status: 200, body: { id: 'M2' } },
      { status: 200, body: { id: 'M2' } },
      { status: 204 },
      { status: 200, body: [{ id: 'M0', content: 'earlier' }] },
      { status: 200, body: { id: 'M1', content: 'first' } }
    ])
    const api = createDiscordRestApi(discord.request)
    expect(await api('bot', discordRoutes.startThread('C1', 'M1', 'Fix the build'))).toEqual({
      kind: 'ok',
      body: { id: 'T1' }
    })
    await api('bot', discordRoutes.createMessage('T1', { content: 'Working' }, 'status:h1:t1'))
    await api('bot', discordRoutes.editMessage('T1', 'M2', { content: 'Done', components: [] }))
    expect(await api('bot', discordRoutes.addReaction('C1', 'M1', '👀'))).toEqual({
      kind: 'ok',
      body: {}
    })
    expect(await api('bot', discordRoutes.messagesBefore('T1', 'M1', 50))).toEqual({
      kind: 'ok',
      body: { items: [{ id: 'M0', content: 'earlier' }] }
    })
    await api('bot', discordRoutes.message('C1', 'M1'))
    expect(discord.calls.map(({ url, init }) => [init.method, url])).toEqual([
      ['POST', 'https://discord.com/api/v10/channels/C1/messages/M1/threads'],
      ['POST', 'https://discord.com/api/v10/channels/T1/messages'],
      ['PATCH', 'https://discord.com/api/v10/channels/T1/messages/M2'],
      ['PUT', 'https://discord.com/api/v10/channels/C1/messages/M1/reactions/%F0%9F%91%80/@me'],
      ['GET', 'https://discord.com/api/v10/channels/T1/messages?before=M1&limit=50'],
      ['GET', 'https://discord.com/api/v10/channels/C1/messages/M1']
    ])
    expect(discord.calls[1]?.init.headers).toEqual({
      authorization: 'Bot bot',
      'content-type': 'application/json'
    })
    expect(discord.calls[3]?.init.headers).toEqual({ authorization: 'Bot bot' })
    expect(discord.sentBody(1)).toEqual({
      content: 'Working',
      allowed_mentions: { parse: [] },
      nonce: discordNonce('status:h1:t1'),
      enforce_nonce: true
    })
    expect(discord.sentBody(2)).toEqual({
      content: 'Done',
      components: [],
      allowed_mentions: { parse: [] }
    })
  })

  it('replies to a writer, pinging only them', async () => {
    const discord = fakeDiscord([])
    await createDiscordRestApi(discord.request)(
      'bot',
      discordRoutes.createMessage('C1', { content: 'Orca is paused.', replyTo: 'M1' }, 'notice:M1')
    )
    expect(discord.sentBody(0)).toMatchObject({
      message_reference: { message_id: 'M1', fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: true }
    })
  })

  it('derives a stable 25-character nonce from a post id', () => {
    const nonce = discordNonce(`reply:${'h'.repeat(40)}:r1`)
    expect(nonce).toHaveLength(25)
    expect(discordNonce(`reply:${'h'.repeat(40)}:r1`)).toBe(nonce)
    expect(discordNonce(`reply:${'h'.repeat(40)}:r2`)).not.toBe(nonce)
  })

  it('trusts the nonce for two minutes after the first send', () => {
    expect(nonceStillDedupes(1_000_000, 1_000_000 + 119_999)).toBe(true)
    expect(nonceStillDedupes(1_000_000, 1_000_000 + 120_000)).toBe(false)
  })

  it('turns a 429 into retry after retry_after, else the Retry-After header', async () => {
    const discord = fakeDiscord([
      {
        status: 429,
        body: { message: 'You are being rate limited.', retry_after: 0.25, global: false }
      },
      { status: 429, body: null, headers: { 'retry-after': '2' } },
      { status: 429, body: null }
    ])
    const api = createDiscordRestApi(discord.request)
    const route = discordRoutes.addReaction('C1', 'M1', '✅')
    expect(await api('bot', route)).toEqual({ kind: 'retry', afterMs: 250 })
    expect(await api('bot', route)).toEqual({ kind: 'retry', afterMs: 2000 })
    expect(await api('bot', route)).toEqual({ kind: 'retry' })
  })

  it('reads errors as failed, server errors and network failures as unknown', async () => {
    const discord = fakeDiscord([
      { status: 403, body: { code: 50001, message: 'Missing Access' } },
      { status: 404, body: { code: 10003, message: 'Unknown Channel' } },
      { status: 400, body: null },
      { status: 502 }
    ])
    const api = createDiscordRestApi(discord.request)
    const route = discordRoutes.createMessage('C1', { content: 'a' }, 'p1')
    expect(await api('bot', route)).toEqual({ kind: 'failed', error: '50001' })
    expect(await api('bot', route)).toEqual({ kind: 'failed', error: '10003' })
    expect(await api('bot', route)).toEqual({ kind: 'failed', error: 'http_400' })
    expect(await api('bot', route)).toEqual({ kind: 'unknown' })
    const offline = createDiscordRestApi(async () => {
      throw new Error('offline')
    })
    expect(await offline('bot', route)).toEqual({ kind: 'unknown' })
  })
})
