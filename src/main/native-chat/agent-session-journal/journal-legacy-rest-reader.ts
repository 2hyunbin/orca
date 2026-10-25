import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-database-path'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'

export function openLegacyRestReader(directory: string): Database.Database {
  const db = new Database(journalDatabasePath(directory), {
    readonly: true,
    fileMustExist: true,
    timeout: 0
  })
  try {
    db.pragma('query_only = ON')
    db.pragma('cache_size = -1024')
    if (
      db.pragma('user_version', { simple: true }) !== JOURNAL_DB_SCHEMA_VERSION ||
      db.pragma('journal_mode', { simple: true }) !== 'wal'
    ) {
      throw new Error('legacy replay requires the host-migrated WAL journal')
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
