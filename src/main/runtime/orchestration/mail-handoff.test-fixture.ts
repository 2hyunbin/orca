import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { onTestFinished, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from '../../sqlite/sync-database'
import type { SqliteBindings, SqliteRow } from '../../sqlite/sqlite-statement'
import type { StructuredMailHandoff } from './mail-handoff'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'

export function mailTestResources(prefix: string) {
  return {
    directory: () => {
      const root = mkdtempSync(join(tmpdir(), prefix))
      onTestFinished(() => rmSync(root, { recursive: true, force: true }))
      return root
    },
    track: <T extends { close: () => void | Promise<void> }>(resource: T): T => {
      onTestFinished(() => resource.close())
      return resource
    }
  }
}

export function mailHandoffFixture(patch: Partial<StructuredMailHandoff>): StructuredMailHandoff {
  const id = mintAgentSessionOperationId(Date.now())
  return {
    version: 1,
    kind: 'structured',
    sessionId: 'session',
    epoch: 'epoch',
    frontier: 'frontier',
    operationId: id,
    authorizationId: id,
    clientMessageId: id,
    phase: 'reserved',
    authority: 'consumer',
    ...patch
  }
}

export function observeMailSql(
  db: Database,
  match: RegExp,
  method: 'all' | 'get',
  visit: (call: { sql: string; args: SqliteBindings; rows: SqliteRow[] }) => void
) {
  const prepare = db.prepare.bind(db)
  const seen = new WeakSet()
  const trace = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (match.test(sql) && !seen.has(statement)) {
      seen.add(statement)
      const observe =
        <T extends SqliteRow[] | SqliteRow | undefined>(read: (...args: SqliteBindings) => T) =>
        (...args: SqliteBindings): T => {
          const result = read(...args)
          visit({ sql, args, rows: Array.isArray(result) ? result : result ? [result] : [] })
          return result
        }
      if (method === 'all') {
        const read = observe(statement.all.bind(statement))
        vi.spyOn(statement, 'all').mockImplementation(read)
      } else {
        const read = observe(statement.get.bind(statement))
        vi.spyOn(statement, 'get').mockImplementation(read)
      }
    }
    return statement
  })
  return {
    trace,
    explain: (sql: string, args: SqliteBindings, column = 'detail') =>
      prepare(`${column === 'opcode' ? 'EXPLAIN' : 'EXPLAIN QUERY PLAN'} ${sql}`)
        .all(...args)
        .map((row) => row[column])
        .join(' ')
  }
}

export function clearedMailRecord(
  record: AgentSessionRecord,
  replacementSessionId: string,
  operationId = 'clear'
): AgentSessionRecord {
  return {
    ...record,
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId,
      callerKey: 'person',
      replacementSessionId
    }
  }
}
