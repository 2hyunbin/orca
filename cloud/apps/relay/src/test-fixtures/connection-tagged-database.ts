import type { RelayDatabase } from '../database.js'

// Each transaction() hands out a handle on the next listed pooled connection.
export function connectionTaggedDatabase(connectionIds: number[]): RelayDatabase {
  const handle = (connectionId?: number): RelayDatabase => ({
    connectionId,
    query: async () => [],
    queryLocked: async () => [],
    transaction: async (operation) => await operation(handle(connectionIds.shift())),
    close: async () => undefined
  })
  return handle()
}
