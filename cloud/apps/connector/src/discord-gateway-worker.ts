import { createAdaptorServer } from '@hono/node-server'
import {
  acquireLeadership,
  type CloudDatabase,
  type CloudNotifications
} from '@orca-cloud/cloud-database'
import { Hono } from 'hono'
import type { ConnectorConfig } from './config.js'
import { createConnectorRuntime } from './connector-runtime.js'
import { saveCheckpoint, takeCheckpoint } from './discord-gateway-checkpoint.js'
import { startDiscordGatewaySession } from './discord-gateway-session.js'

const LEADER_KEY = 'orca-connector-discord-gateway'

// The discord-gateway role: one leader across instances holds the gateway session and routes each
// message in the transaction that commits its checkpoint. Resolves with the exit code.
export async function runDiscordGatewayWorker(input: {
  config: ConnectorConfig
  database: CloudDatabase
  notifications: CloudNotifications
  signal: AbortSignal
}): Promise<number> {
  const { config, database, notifications, signal } = input
  const now = Date.now
  const runtime = createConnectorRuntime(config, database, notifications, { now })
  const discord = runtime.discord
  if (!config.discord || !discord) {
    throw new Error('The discord-gateway role needs the Discord settings')
  }
  // Cloud Run needs a listening port; health is all this role serves.
  const app = new Hono()
  app.get('/health', (context) => context.json({ ok: true, role: config.role }))
  const server = createAdaptorServer(app)
  server.listen(config.port)
  try {
    const leadership = await acquireLeadership({
      ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
      key: LEADER_KEY,
      applicationName: 'orca-connector',
      signal
    })
    const fatal = Promise.withResolvers<string>()
    const { epoch, resumeFrom } = await takeCheckpoint(database, now())
    const session = await startDiscordGatewaySession({
      token: config.discord.botToken,
      resumeFrom,
      // The checkpoint moves first, so a fenced leader's routing never runs.
      commit: (step) =>
        database.transaction(async (transaction) => {
          await saveCheckpoint(transaction, epoch, step.checkpoint, now())
          if (step.message) {
            await discord.routeIn(transaction, runtime.core, step.message)
          }
        }),
      onFatal: fatal.resolve
    })
    const stopped = new Promise<string>((resolve) =>
      signal.addEventListener('abort', () => resolve('stopping'), { once: true })
    )
    const reason = await Promise.race([
      fatal.promise,
      leadership.lost.then(() => 'leadership_lost'),
      stopped
    ])
    console.log(JSON.stringify({ event: 'orca_connector_discord_gateway_stopping', reason }))
    await session.close({ drain: reason === 'stopping' })
    await leadership.release()
    return reason === 'stopping' ? 0 : 1
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
