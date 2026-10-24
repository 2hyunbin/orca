import { expect } from 'vitest'
import { deserialize } from 'node:v8'
import Database from '../../sqlite/sync-database'
import { populationEncodedBytes, type PopulationCost } from './journal-population-cost-test-support'

type Interceptor = (owner: object, args: unknown[], call: (args: unknown[]) => unknown) => unknown

/** Real statement executions, cardinalities and encoded buffers, including failed executions. */
export function instrumentPopulationSql(
  wrap: (target: object, property: PropertyKey, intercept: Interceptor) => void,
  current: () => PopulationCost | undefined
): void {
  const statements = new WeakSet<object>()
  wrap(Database.prototype, 'exec', (_owner, args, call) => {
    const cost = current()
    if (cost && typeof args[0] === 'string') {
      cost.sqlExecStatements += args[0].split(';').filter((part) => part.trim()).length
    }
    return call(args)
  })
  wrap(Database.prototype, 'prepare', (_owner, args, call) => {
    const statement = call(args)
    const sql = args[0]
    if (typeof statement !== 'object' || statement === null || typeof sql !== 'string') {
      throw new Error('invalid SQLite statement')
    }
    if (!statements.has(statement)) {
      statements.add(statement)
      for (const method of ['get', 'all', 'run']) {
        wrap(statement, method, (_statement, parameters, execute) => {
          const cost = current()
          if (cost) {
            cost.sqlCalls++
            const bytes = populationEncodedBytes(parameters)
            cost.encodedBytes += bytes
            if (/INSERT OR REPLACE INTO checkpoint/.test(sql)) {
              cost.checkpointBytes += bytes
            }
          }
          let result: unknown
          try {
            result = execute(parameters)
          } catch (error) {
            if (cost) {
              cost.failedSql++
            }
            throw error
          }
          if (cost) {
            cost.encodedBytes += populationEncodedBytes(result)
            if (method === 'run' && result && typeof result === 'object') {
              const changed = Number(Reflect.get(result, 'changes'))
              cost.changedRows += changed
              if (/\bDELETE\s+FROM\s+relations\b/i.test(sql)) {
                if (
                  sql.trim() === 'DELETE FROM relations WHERE space = ? AND key = ?' ||
                  sql.trim() === 'DELETE FROM relations WHERE id = ?'
                ) {
                  expect(changed, sql).toBeLessThanOrEqual(1)
                } else {
                  cost.populationDeletes += Math.max(1, changed)
                }
              }
              cost.secondaryWrites += /relations|context_clears|queued_messages/.test(sql)
                ? 2 * changed
                : changed
            } else {
              const rows = Array.isArray(result) ? result.length : result ? 1 : 0
              cost.sqlRows += rows
              if (
                rows === 0 &&
                /SELECT id,key,value FROM relations|ORDER BY seq ASC LIMIT/i.test(sql)
              ) {
                cost.terminalCursorProbes++
              }
              if (/SELECT id,key,value FROM relations/i.test(sql)) {
                cost.rangeRows += rows
              }
              if (/COUNT\(\*\)/i.test(sql) && result && typeof result === 'object') {
                const cardinality = Number(Reflect.get(result, 'n') ?? 0)
                cost.countCardinality += cardinality
                const space =
                  parameters[0] instanceof Uint8Array
                    ? String(deserialize(Buffer.from(parameters[0])))
                    : 'all'
                cost.countNamespaces[space] = (cost.countNamespaces[space] ?? 0) + cardinality
              }
            }
          }
          return result
        })
      }
    }
    return statement
  })
}
