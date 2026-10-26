import { describe, expect, it } from 'vitest'
import type { ClaimedPost } from './connector-posts.js'
import { DiscordPostSender } from './discord-post-sender.js'
import type { DiscordResult, DiscordRoute } from './discord-rest.js'

// Outcomes per https://docs.discord.com/developers/resources/message (create with enforce_nonce).
const NOW = 1_800_000_000_000
const post = (fields: Partial<ClaimedPost> = {}): ClaimedPost => ({
  postId: 'reply:h1:r1',
  workspaceId: 'G1',
  containerId: 'C1',
  threadId: 'T1',
  kind: 'message',
  body: { content: 'done' },
  rev: 0,
  attempts: 1,
  messageRef: null,
  stale: false,
  sentAt: NOW,
  leaseUntil: NOW + 120_000,
  ...fields
})

function sender(...results: DiscordResult[]) {
  const routes: DiscordRoute[] = []
  const api = async (_token: string, route: DiscordRoute) => {
    routes.push(route)
    return results.shift() ?? { kind: 'ok' as const, body: { id: 'M1' } }
  }
  return { routes, sender: new DiscordPostSender({ botToken: 'bot', api, now: () => NOW }) }
}

describe('DiscordPostSender', () => {
  it('resends a post left mid-send while its nonce still dedupes, and calls it uncertain after', async () => {
    const within = sender()
    expect(await within.sender.send(post({ stale: true, sentAt: NOW - 60_000 }))).toEqual({
      kind: 'posted',
      messageRef: 'M1'
    })
    const past = sender()
    expect(await past.sender.send(post({ stale: true, sentAt: NOW - 120_000 }))).toEqual({
      kind: 'uncertain'
    })
    expect(past.routes).toEqual([])
  })

  it('retries an unclear send, waits out a rate limit, and gives up on a refusal', async () => {
    expect(await sender({ kind: 'unknown' }).sender.send(post())).toEqual({ kind: 'retry' })
    expect(await sender({ kind: 'retry', afterMs: 500 }).sender.send(post())).toEqual({
      kind: 'retry',
      afterMs: 500
    })
    expect(await sender({ kind: 'failed', error: '50013' }).sender.send(post())).toEqual({
      kind: 'failed'
    })
  })

  it('edits a status in its thread and never sends a private post', async () => {
    const edit = sender()
    await edit.sender.send(post({ kind: 'status', messageRef: 'M9' }))
    expect(edit.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'PATCH /channels/T1/messages/M9'
    ])
    expect(await sender().sender.send(post({ kind: 'ephemeral' }))).toEqual({ kind: 'failed' })
  })
})
