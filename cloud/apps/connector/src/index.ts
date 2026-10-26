import { loadConnectorConfig } from './config.js'
import { openConnectorDatabase } from './connector-database.js'
import { createConnectorServer } from './connector-server.js'

const config = loadConnectorConfig()
const database = await openConnectorDatabase({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  dataDir: config.dataDir,
  poolMax: config.databasePoolMax,
  applicationName: 'orca-connector',
  readOnly: config.mode === 'validation'
})
const runtime = createConnectorServer(config, database)

runtime.server.listen(config.port, () => {
  console.log(`[orca-connector] listening on ${config.publicUrl} (port ${config.port})`)
})

let stopping = false
const shutdown = (): void => {
  if (stopping) {
    return
  }
  stopping = true
  // Cloud Run sends SIGKILL after ten seconds; leave time for explicit cleanup.
  const deadline = setTimeout(() => process.exit(1), 9_000)
  deadline.unref()
  const requests = runtime.requestDrain.begin()
  const connections = new Promise<void>((resolve) => runtime.server.close(() => resolve()))
  void Promise.all([requests, connections])
    .then(async () => {
      await database.close()
      clearTimeout(deadline)
    })
    .catch(() => {
      console.warn(JSON.stringify({ event: 'orca_connector_shutdown_failed' }))
      process.exitCode = 1
    })
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
