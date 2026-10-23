import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import SyncDatabase from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { readStreamedSessionDocument } from '../../ai-vault/session-document-stream'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

const CATALOG_SCHEMA = [
  'CREATE TABLE catalog (fingerprint TEXT PRIMARY KEY, agent TEXT NOT NULL, payload TEXT NOT NULL, position INTEGER NOT NULL)',
  'CREATE TABLE catalog_state (id INTEGER PRIMARY KEY CHECK(id=1), committed INTEGER NOT NULL CHECK(committed=1))'
]
function committedCatalog(db: SyncDatabase): boolean {
  const version = db.pragma('user_version', { simple: true })
  const schema = [
    ...db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").iterate()
  ]
  if (version === 0 && schema.length === 0) {
    return false
  }
  if (
    version !== 1 ||
    schema.length !== CATALOG_SCHEMA.length ||
    schema.some((row) => typeof row.sql !== 'string' || !CATALOG_SCHEMA.includes(row.sql)) ||
    db.prepare('SELECT committed FROM catalog_state WHERE id=1').get()?.committed !== 1
  ) {
    throw new Error('Unrecognized model catalog database authority')
  }
  return true
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Private catalog I/O; the attached persistence drain serializes its operations. */
export function createAgentModelCatalogDatabase(
  directory: string,
  parseEntry: (value: unknown) => AgentModelCatalogEntry | null,
  persistedEntry: (entry: AgentModelCatalogEntry) => unknown,
  schemaVersion: number
) {
  const path = join(directory, 'agent-model-catalog.db')
  let connection: SyncDatabase | null = null
  let committed = false
  let loading: Promise<AgentModelCatalogEntry[]> | null = null
  const retire = (): void => {
    if (connection?.isTransaction) {
      connection.exec('ROLLBACK')
    }
    connection?.close()
    connection = null
  }
  const legacy = async (): Promise<AgentModelCatalogEntry[]> => {
    const stream = createReadStream(join(directory, 'agent-model-catalog.json'), {
      highWaterMark: 64 * 1024
    })
    try {
      const result = await readStreamedSessionDocument({
        bytes: stream,
        arrayKey: 'entries',
        fields: ['version'],
        includeArrayValidity: true,
        create: () => new Map<string, AgentModelCatalogEntry>(),
        consume: (rows, value) => {
          const entry = parseEntry(value)
          if (entry && !rows.has(entry.fingerprint)) {
            rows.set(entry.fingerprint, entry)
          }
        }
      })
      if (!result || result.record.version !== schemaVersion || !result.arrayValid) {
        throw new SyntaxError('Invalid legacy model catalog document')
      }
      return [...result.state.values()]
    } catch (error) {
      if (missing(error)) {
        return []
      }
      throw error
    } finally {
      stream.destroy()
      await finished(stream).catch(() => {})
    }
  }
  const read = (): Promise<AgentModelCatalogEntry[]> => {
    loading ??= (async () => {
      retire()
      let exists = true
      try {
        await stat(path)
      } catch (error) {
        if (!missing(error)) {
          throw error
        }
        exists = false
      }
      if (committed && !exists) {
        throw new Error('Committed model catalog database is missing')
      }
      if (exists) {
        try {
          connection = new SyncDatabase(path, { fileMustExist: true, timeout: 0 })
          const authority = committedCatalog(connection)
          if (committed && !authority) {
            throw new Error('Committed catalog authority was replaced')
          }
          committed = authority
          if (committed) {
            const rows: AgentModelCatalogEntry[] = []
            for (const row of connection
              .prepare('SELECT fingerprint,agent,payload,position FROM catalog ORDER BY position')
              .iterate()) {
              const entry =
                typeof row.payload === 'string' ? parseEntry(JSON.parse(row.payload)) : null
              if (
                !entry ||
                entry.fingerprint !== row.fingerprint ||
                entry.agent !== row.agent ||
                row.position !== rows.length
              ) {
                throw new Error('Invalid model catalog source row')
              }
              rows.push(entry)
              await yieldToEventLoop()
            }
            return rows
          }
        } finally {
          retire()
        }
      }
      return legacy()
    })().finally(() => {
      loading = null
    })
    return loading
  }
  const write = async (
    rows: AgentModelCatalogEntry[],
    acknowledged: ReadonlyMap<string, AgentModelCatalogEntry>
  ): Promise<void> => {
    await loading
    retire()
    await mkdir(directory, { recursive: true })
    try {
      connection = new SyncDatabase(path, { fileMustExist: committed, timeout: 0 })
      const initialized = committedCatalog(connection)
      if (committed && !initialized) {
        throw new Error('Committed catalog authority was replaced')
      }
      connection.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      if (!initialized) {
        for (const sql of CATALOG_SCHEMA) {
          connection.exec(sql)
        }
        connection.exec('PRAGMA user_version=1')
      }
      connection.exec('INSERT OR REPLACE INTO catalog_state VALUES(1,1)')
      hardenSqliteDatabaseFiles(path)
      hardenSqliteDatabaseFiles(`${path}-journal`)
      const retained = new Set(rows.map((row) => row.fingerprint))
      const priorOrder = [...acknowledged.keys()]
      for (let position = 0; position < rows.length; position++) {
        const entry = rows[position]!
        if (!initialized || acknowledged.get(entry.fingerprint) !== entry) {
          const payload = JSON.stringify(persistedEntry(entry))
          connection
            .prepare('INSERT OR REPLACE INTO catalog VALUES(?,?,?,?)')
            .run(entry.fingerprint, entry.agent, payload, position)
        } else if (priorOrder[position] !== entry.fingerprint) {
          connection
            .prepare('UPDATE catalog SET position=? WHERE fingerprint=?')
            .run(position, entry.fingerprint)
        }
        await yieldToEventLoop()
      }
      const identities = Array.from(connection.prepare('SELECT fingerprint FROM catalog').iterate())
      for (const row of identities) {
        if (typeof row.fingerprint !== 'string') {
          throw new Error('Invalid catalog identity')
        }
        if (!retained.has(row.fingerprint)) {
          connection.prepare('DELETE FROM catalog WHERE fingerprint=?').run(row.fingerprint)
          await yieldToEventLoop()
        }
      }
      connection.exec('COMMIT')
      committed = true
    } finally {
      retire()
    }
  }
  return { read, write, isCommitted: () => committed }
}
