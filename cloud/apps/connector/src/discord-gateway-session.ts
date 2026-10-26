import { DiscordAPIError, REST } from '@discordjs/rest'
import { CloseCodes, WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws'
import { z } from 'zod'
import { DiscordThreadParents, readDiscordMessage, type DiscordMessage } from './discord-events.js'

// GUILDS (thread events), GUILD_MESSAGES, MESSAGE_CONTENT (privileged).
// https://docs.discord.com/developers/events/gateway
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)
// Bad token, shard, version or intents: the library stops, and so should the worker.
// https://docs.discord.com/developers/topics/opcodes-and-status-codes
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
// @discordjs/rest retries server errors (3 times) and waits out 429s; this bounds both.
const CHANNEL_LOOKUP_MS = 10_000
// A channel that is gone or out of reach never will be: its message is skipped, not retried.
const TERMINAL_LOOKUP_STATUSES = new Set([403, 404])

const BotUserSchema = z.looseObject({ id: z.string().min(1) })
const ReadySchema = z.looseObject({ session_id: z.string().min(1), resume_gateway_url: z.string() })

// Where a new leader resumes: the session and the last dispatch committed with its effects.
export type GatewayCheckpoint = { sessionId: string; resumeURL: string; sequence: number }

// threadParentId: set when a mention's channel is a thread.
export type DiscordGatewayMessage = DiscordMessage & { threadParentId?: string }

// One dispatch: the message it carries, if any, and the checkpoint just past it.
export type GatewayStep = { checkpoint: GatewayCheckpoint; message: DiscordGatewayMessage | null }

export type DiscordGatewaySession = {
  // Closes resumably; the next leader resumes from the committed checkpoint.
  handOver(): Promise<void>
}

// One gateway session (one shard) through @discordjs/ws, which owns identify, heartbeat, resume
// and reconnects. Dispatches are committed one at a time, in order; a failed one ends the session
// so the next leader replays it from the last committed checkpoint.
export async function startDiscordGatewaySession(deps: {
  token: string
  resumeFrom: GatewayCheckpoint | null
  commit: (step: GatewayStep) => Promise<void>
  // Discord refused the session, or a dispatch couldn't be committed; the worker exits.
  onFatal: (reason: string) => void
  rest?: REST
}): Promise<DiscordGatewaySession> {
  const rest = (deps.rest ?? new REST()).setToken(deps.token)
  // A resumed session gets no READY, so the bot's own id comes from REST.
  const botUserId = BotUserSchema.parse(await rest.get('/users/@me')).id
  const { resumeFrom } = deps
  // The library's own resume state, in memory; the committed checkpoint is what survives a crash.
  let session: SessionInfo | null = resumeFrom && { ...resumeFrom, shardId: 0, shardCount: 1 }
  let current = resumeFrom
  const parents = new DiscordThreadParents()
  let failed = false
  let committing = Promise.resolve()

  // A mention's channel the gateway hasn't described yet is looked up once; null skips it.
  const withParent = async (message: DiscordMessage): Promise<DiscordGatewayMessage | null> => {
    if (message.mentioned && parents.parentOf(message.channelId) === undefined) {
      try {
        parents.learnChannel(
          await rest.get(`/channels/${message.channelId}`, {
            signal: AbortSignal.timeout(CHANNEL_LOOKUP_MS)
          })
        )
      } catch (error) {
        if (error instanceof DiscordAPIError && TERMINAL_LOOKUP_STATUSES.has(error.status)) {
          console.warn(
            JSON.stringify({
              event: 'orca_connector_discord_channel_unreachable',
              status: error.status
            })
          )
          return null
        }
        throw error
      }
    }
    const threadParentId = parents.parentOf(message.channelId)
    return typeof threadParentId === 'string' ? { ...message, threadParentId } : message
  }

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
      session = info
    }
  })
  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    parents.apply(payload.t, payload.d)
    if (payload.t === 'READY') {
      const ready = ReadySchema.parse(payload.d)
      if (current !== null) {
        // A refused resume: the dispatches in between are lost.
        console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fresh_session' }))
      }
      current = { sessionId: ready.session_id, resumeURL: ready.resume_gateway_url, sequence: 0 }
    }
    if (current === null) {
      return
    }
    const checkpoint = { ...current, sequence: payload.s }
    current = checkpoint
    const parsed = payload.t === 'MESSAGE_CREATE' ? readDiscordMessage(payload.d, botUserId) : null
    committing = committing.then(async () => {
      if (failed) {
        return
      }
      try {
        await deps.commit({ checkpoint, message: parsed && (await withParent(parsed)) })
      } catch {
        failed = true
        console.warn(JSON.stringify({ event: 'orca_connector_discord_dispatch_failed' }))
        deps.onFatal('dispatch_failed')
      }
    })
  })
  manager.on(WebSocketShardEvents.Closed, (code) => {
    if (FATAL_CLOSE_CODES.has(code)) {
      console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fatal', code }))
      deps.onFatal(`close_${code}`)
    }
  })
  manager.on(WebSocketShardEvents.Error, () => {
    console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_error' }))
  })
  await manager.connect()
  return {
    handOver: async () => {
      await manager.destroy({ code: CloseCodes.Resuming })
      await committing
    }
  }
}
