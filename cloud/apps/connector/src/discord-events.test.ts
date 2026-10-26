import { describe, expect, it } from 'vitest'
import { DiscordThreadParents, readDiscordMessage } from './discord-events.js'

// Shapes from https://docs.discord.com/developers/resources/message and the GUILD_CREATE /
// THREAD_* events in https://docs.discord.com/developers/events/gateway-events.
const BOT = '1200000000000000000'
const message = {
  id: 'M1',
  channel_id: 'C1',
  guild_id: 'G1',
  author: { id: 'U1', username: 'owner' },
  content: `<@${BOT}> hi`,
  mentions: [{ id: BOT }],
  mention_roles: [],
  type: 0
}

describe('readDiscordMessage', () => {
  it('reads a member’s message and whether it mentions the bot', () => {
    expect(readDiscordMessage(message, BOT)).toEqual({
      guildId: 'G1',
      channelId: 'C1',
      messageId: 'M1',
      userId: 'U1',
      content: `<@${BOT}> hi`,
      mentioned: true
    })
    expect(readDiscordMessage({ ...message, mentions: [] }, BOT)?.mentioned).toBe(false)
  })

  it.each([
    ['a DM', { guild_id: undefined }],
    ['a bot', { author: { id: 'B1', bot: true } }],
    ['ourselves', { author: { id: BOT } }],
    ['a webhook', { webhook_id: 'W1' }],
    ['a thread notice', { type: 18 }],
    ['a malformed payload', { id: undefined }]
  ])('drops %s', (_name, override) => {
    expect(readDiscordMessage({ ...message, ...override }, BOT)).toBeNull()
  })
})

describe('DiscordThreadParents', () => {
  it('follows threads from guild state, events and channel lookups; a plain channel has none', () => {
    const parents = new DiscordThreadParents()
    parents.apply('GUILD_CREATE', { id: 'G1', threads: [{ id: 'T1', parent_id: 'C1', type: 11 }] })
    parents.apply('THREAD_CREATE', { id: 'T2', parent_id: 'C2', type: 11 })
    parents.apply('THREAD_LIST_SYNC', { guild_id: 'G1', threads: [{ id: 'T3', parent_id: 'C1' }] })
    parents.apply('THREAD_DELETE', { id: 'T2', parent_id: 'C2', type: 11 })
    parents.apply('MESSAGE_CREATE', { id: 'T9', parent_id: 'C9' })
    parents.learnChannel({ id: 'T4', type: 12, parent_id: 'C4' })
    parents.learnChannel({ id: 'C5', type: 0, parent_id: 'CAT1' })
    expect(['T1', 'T2', 'T3', 'T9', 'T4', 'C5'].map((id) => parents.parentOf(id))).toEqual([
      'C1',
      undefined,
      'C1',
      undefined,
      'C4',
      null
    ])
  })
})
