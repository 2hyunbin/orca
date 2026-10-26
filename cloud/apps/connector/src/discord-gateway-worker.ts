import { createAdaptorServer } from '@hono/node-server'
import {
  acquireLeadership,
  type CloudDatabase,
  type CloudNotifications
} from '@orca-cloud/cloud-database'
import { Hono } from 'hono'
import type { ConnectorConfig } from './config.js'
import { createConnectorRuntime } from './connector-runtime.js'
import { startDiscordGatewaySession, type GatewayCheckpoint } from './discord-gateway-session.js'

const LEADER_KEY = 'orca-connector-discord-gateway'
// The one checkpoint row.
const SLOT = 1

async function loadCheckpoint(database: CloudDatabase): Promise<GatewayCheckpoint | null> {
  const [row] = await database.query(
    'SELECT session_id, resume_url, sequence FROM connector_discord_gateway WHERE slot = ?',
    [SLOT]
  )
  return row
    ? {
        sessionId: String(row.session_id),
        resumeURL: String(row.resume_url),
        sequence: Number(row.sequence)
      }
    : null
}

async function saveCheckpoint(
  transaction: CloudDatabase,
  checkpoint: GatewayCheckpoint,
  now: number
): Promise<void> {
  await transaction.query(
    `INSERT INTO connector_discord_gateway (slot, session_id, resume_url, sequence, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (slot) DO UPDATE SET session_id = excluded.session_id,
       resume_url = excluded.resume_url, sequence = excluded.sequence,
       updated_at = excluded.updated_at`,
    [SLOT, checkpoint.sessionId, checkpoint.resumeURL, checkpoint.sequence, now]
  )
}

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
    const session = await startDiscordGatewaySession({
      token: config.discord.botToken,
      resumeFrom: await loadCheckpoint(database),
      commit: (step) =>
        database.transaction(async (transaction) => {
          if (step.message) {
            await discord.routeIn(transaction, runtime.core, step.message)
          }
          await saveCheckpoint(transaction, step.checkpoint, now())
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
    await session.handOver()
    await leadership.release()
    return reason === 'stopping' ? 0 : 1
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
