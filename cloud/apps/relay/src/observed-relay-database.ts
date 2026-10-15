import type {
  RelayDatabase,
  RelayLockOptions,
  RelayTransactionOptions,
  SqlRow
} from './database.js'
import { timedRelayOperation, type RelayRuntimeObserver } from './relay-observability.js'
import { noteStickySlotStatement } from './sticky-slot-statements.js'

export function observeRelayDatabase(
  database: RelayDatabase,
  observer: RelayRuntimeObserver
): RelayDatabase {
  const observe = (durationMs: number, success: boolean): void => {
    observer.recordSql(durationMs, success)
    noteStickySlotStatement(durationMs, database.connectionId)
  }
  const query = (sql: string, params?: unknown[]): Promise<SqlRow[]> =>
    timedRelayOperation(() => database.query(sql, params), observe)
  const queryLocked = (
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> =>
    timedRelayOperation(
      () => database.queryLocked(sql, params, options),
      observe,
      (error) =>
        // NOWAIT contention is an intentional sweep deferral, not a SQL-health failure.
        options?.failIfUnavailable === true &&
        error instanceof Error &&
        error.message === 'database_lock_unavailable'
    )
  const queryPriority = database.queryPriority?.bind(database)
  const commitWithFinal = database.commitWithFinal?.bind(database)
  return {
    dialect: database.dialect,
    query,
    queryLocked,
    ...(queryPriority
      ? {
          queryPriority: (sql: string, params?: unknown[]): Promise<SqlRow[]> =>
            timedRelayOperation(() => queryPriority(sql, params), observe)
        }
      : {}),
    ...(commitWithFinal
      ? {
          commitWithFinal: (sql: string, params?: unknown[]): Promise<boolean> =>
            timedRelayOperation(() => commitWithFinal(sql, params), observe)
        }
      : {}),
    transaction: async <T>(
      operation: (transaction: RelayDatabase) => Promise<T>,
      options?: RelayTransactionOptions
    ): Promise<T> =>
      await database.transaction(
        async (transaction) => await operation(observeRelayDatabase(transaction, observer)),
        options
      ),
    close: async () => await database.close()
  }
}
