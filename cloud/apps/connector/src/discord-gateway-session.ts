import { REST } from '@discordjs/rest'
import { CloseCodes, WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws'
import { z } from 'zod'
import { DiscordThreadParents, readDiscordMessage, type DiscordMessage } from './discord-events.js'

// GUILDS (thread events), GUILD_MESSAGES, MESSAGE_CONTENT (privileged).
// https://docs.discord.com/developers/events/gateway
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)
// Bad token, shard, version or intents: the library stops, and so should the worker.
// https://docs.discord.com/developers/topics/opcodes-and-status-codes
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
const SESSION_SAVE_MS = 5_000
// @discordjs/rest retries server errors (3 times) and waits out 429s; this bounds both.
const CHANNEL_LOOKUP_MS = 10_000

const BotUserSchema = z.looseObject({ id: z.string().min(1) })

// The resume row: the session a new leader resumes, null when the next connect must identify.
export type DiscordGatewaySessionStore = {
  load(): Promise<SessionInfo | null>
  save(session: SessionInfo | null): Promise<void>
}

// threadParentId: set when the channel is a thread. A mention's channel is looked up once if the
// gateway hasn't described it; the mention is dropped (and logged) if that lookup still fails.
export type DiscordGatewayMessage = DiscordMessage & { threadParentId?: string }

export type DiscordGatewaySession = {
  // Closes resumably and saves the session, so the next leader resumes it.
  handOver(): Promise<void>
}

// One gateway session (one shard) through @discordjs/ws, which owns identify, heartbeat, resume
// and reconnects. Passes on bot mentions, and other messages only in threads we own, in order.
export async function startDiscordGatewaySession(deps: {
  token: string
  store: DiscordGatewaySessionStore
  ownsThread: (channelId: string) => Promise<boolean>
  onMessage: (message: DiscordGatewayMessage) => Promise<void>
  // Discord refused the token, intents or version; the worker should exit and alert.
  onFatal: (closeCode: number) => void
  rest?: REST
}): Promise<DiscordGatewaySession> {
  const rest = (deps.rest ?? new REST()).setToken(deps.token)
  // A resumed session gets no READY, so the bot's own id comes from REST.
  const botUserId = BotUserSchema.parse(await rest.get('/users/@me')).id
  let session = await deps.store.load()
  let handingOver = false
  let saveTimer: NodeJS.Timeout | undefined
  let saving = Promise.resolve()
  const save = (): void => {
    saveTimer = undefined
    const current = session
    saving = saving
      .then(() => deps.store.save(current))
      .catch(() => {
        console.warn(JSON.stringify({ event: 'orca_connector_discord_session_save_failed' }))
      })
  }
  const parents = new DiscordThreadParents()
  let delivery = Promise.resolve()

  const manager = new WebSocketManager({
    token: deps.token,
    intents: DISCORD_GATEWAY_INTENTS,
    rest,
    shardCount: 1,
    identifyProperties: {
      os: process.platform,
      browser: 'orca-connector',
      device: 'orca-connector'
    },
    retrieveSessionInfo: () => session,
    updateSessionInfo: (_shardId, info) => {
      // Shutting down clears the library's session; the handover keeps it for the next leader.
      if (handingOver) {
        return
      }
      session = info
      saveTimer ??= setTimeout(save, SESSION_SAVE_MS)
    }
  })
  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    const type: string = payload.t
    parents.apply(type, payload.d)
    const message = type === 'MESSAGE_CREATE' ? readDiscordMessage(payload.d, botUserId) : null
    if (message === null) {
      return
    }
    delivery = delivery
      .then(async () => {
        if (!message.mentioned && !(await deps.ownsThread(message.channelId))) {
          return
        }
        if (message.mentioned && parents.parentOf(message.channelId) === undefined) {
          parents.learnChannel(
            await rest.get(`/channels/${message.channelId}`, {
              signal: AbortSignal.timeout(CHANNEL_LOOKUP_MS)
            })
          )
        }
        const threadParentId = parents.parentOf(message.channelId)
        await deps.onMessage(
          typeof threadParentId === 'string' ? { ...message, threadParentId } : message
        )
      })
      .catch(() => {
        const { guildId, channelId, messageId } = message
        console.warn(
          JSON.stringify({
            event: 'orca_connector_discord_message_dropped',
            guildId,
            channelId,
            messageId
          })
        )
      })
  })
  manager.on(WebSocketShardEvents.Closed, (code) => {
    if (FATAL_CLOSE_CODES.has(code)) {
      console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fatal', code }))
      deps.onFatal(code)
    }
  })
  manager.on(WebSocketShardEvents.Error, () => {
    console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_error' }))
  })
  await manager.connect()
  return {
    handOver: async () => {
      handingOver = true
      clearTimeout(saveTimer)
      await manager.destroy({ code: CloseCodes.Resuming })
      await delivery
      save()
      await saving
    }
  }
}
