import { createAdaptorServer } from '@hono/node-server'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { Hono } from 'hono'
import type { ConnectorConfig } from './config.js'
import { limitByClientIp, RateLimiter } from './rate-limiter.js'
import { RequestDrain } from './request-drain.js'

const UNAUTHENTICATED_PER_MINUTE_PER_IP = 30

export type ConnectorServerOptions = {
  now?: () => number
}

export function createConnectorServer(
  config: ConnectorConfig,
  database: CloudDatabase,
  options: ConnectorServerOptions = {}
) {
  const now = options.now ?? Date.now
  const limitUnauthenticated = limitByClientIp(
    new RateLimiter(UNAUTHENTICATED_PER_MINUTE_PER_IP, now),
    config.trustedProxyHops
  )

  const app = new Hono()
  const requestDrain = new RequestDrain()
  app.use('*', requestDrain.middleware)
  // Default logging can carry row detail; log only the error's name.
  app.onError((error, context) => {
    console.warn(
      JSON.stringify({
        event: 'orca_connector_request_failed',
        error: error instanceof Error ? error.name : 'unknown'
      })
    )
    return context.json({ error: 'internal' }, 500)
  })

  app.get('/health', (context) => context.json({ ok: true, mode: config.mode }))
  app.get('/ready', limitUnauthenticated, async (context) =>
    (await database.query('SELECT 1 AS ready').then(
      () => true,
      () => false
    ))
      ? context.json({ ok: true })
      : context.json({ error: 'dependency_unavailable' }, 503)
  )

  if (config.mode === 'validation') {
    app.use('*', async (context) => context.json({ error: 'validation_only' }, 503))
  }

  return { app, requestDrain, server: createAdaptorServer(app) }
}
