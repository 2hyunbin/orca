import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAdaptorServer } from '@hono/node-server'
import {
  acquireLeadership,
  type CloudDatabase,
  type CloudNotifications
} from '@orca-cloud/cloud-database'
import { Hono } from 'hono'
import type { ConnectorConfig } from './config.js'
import { createConnectorRuntime } from './connector-runtime.js'
import { loadCheckpoint, saveCheckpoint } from './discord-gateway-checkpoint.js'
import { startDiscordGatewaySession } from './discord-gateway-session.js'
import { createDiscordRestApi } from './discord-rest.js'

const LEADER_KEY = 'orca-connector-discord-gateway'
// Cloud Run sends SIGKILL ten seconds after SIGTERM; past this the process exits regardless.
const CLOSE_DEADLINE_MS = 8_000

// The discord-gateway role: one leader across instances holds the gateway session and routes each
// message in the transaction that commits its checkpoint, on the lock's own connection, so a leader
// that lost the lock can't commit. Resolves with the exit code.
export async function runDiscordGatewayWorker(input: {
  config: ConnectorConfig
  database: CloudDatabase
  notifications: CloudNotifications
  signal: AbortSignal
}): Promise<number> {
  const { config, database, notifications, signal } = input
  const runtime = createConnectorRuntime(config, database, notifications, { now: Date.now })
  const discord = runtime.discord
  if (!config.discord || !discord) {
    throw new Error('The discord-gateway role needs the Discord settings')
  }
  const stopped = signal.aborted ? Promise.resolve() : once(signal, 'abort').then(() => undefined)
  // Cloud Run needs a listening port; health is all this role serves.
  const app = new Hono()
  app.get('/health', (context) => context.json({ ok: true, role: config.role }))
  const server = createAdaptorServer(app)
  server.listen(config.port)
  try {
    const leadership = await acquireLeadership({
      ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
      database,
      key: LEADER_KEY,
      applicationName: 'orca-connector',
      signal
    })
    try {
      const fatal = Promise.withResolvers<string>()
      const ended = Promise.race([
        fatal.promise,
        leadership.lost.then(() => 'leadership_lost'),
        stopped.then(() => 'stopping')
      ])
      const starting = startDiscordGatewaySession({
        token: config.discord.botToken,
        api: createDiscordRestApi(),
        guildIds: config.discord.guildIds,
        resumeFrom: await loadCheckpoint(database),
        commit: (step) =>
          leadership.transaction(async (transaction) => {
            await saveCheckpoint(transaction, step.checkpoint)
            if (step.message) {
              await discord.routeIn(transaction, runtime.core, step.message)
            }
          }),
        onFatal: fatal.resolve
      })
      // A stop or lost lock during startup ends the process, which closes the half-open session.
      const session = await Promise.race([starting, ended])
      const reason = typeof session === 'string' ? session : await ended
      console.log(JSON.stringify({ event: 'orca_connector_discord_gateway_stopping', reason }))
      if (typeof session !== 'string') {
        await Promise.race([
          session.close({ drain: reason === 'stopping' }),
          sleep(CLOSE_DEADLINE_MS, undefined, { ref: false })
        ])
      }
      return reason === 'stopping' ? 0 : 1
    } finally {
      await leadership.release()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
