import type pg from 'pg'
import {
  hashedRowText,
  pkJson,
  pkRange,
  quoteIdent,
  tableRef,
  type MoveTable
} from './database-move-catalog.js'
import { logMoveEvent, sleep } from './database-move-events.js'

export type MoveRangeMismatch = {
  // Exclusive lower and inclusive upper pk (JSON text); null = open end.
  after: string | null
  through: string | null
  referenceRows: number
  otherRows: number
  keys: string[]
}

export type MoveTableVerdict = {
  table: string
  referenceRows: number
  otherRows: number
  mismatches: MoveRangeMismatch[]
}

export type MoveVerifyOptions = {
  chunkRows?: number
  // Rows read on both sides per second; 0 = unpaced.
  maxRowsPerSecond?: number
  maxReportedKeys?: number
}

function rangeWhere(
  table: MoveTable,
  after: string | null,
  through: string | null
): { sql: string; params: string[] } {
  const range = pkRange(table, after, through)
  return {
    sql: range.clauses.length > 0 ? `WHERE ${range.clauses.join(' AND ')}` : '',
    params: range.params
  }
}

function orderBy(table: MoveTable): string {
  return table.primaryKey.map((column) => `mv_r.${quoteIdent(column)}`).join(', ')
}

async function rangeHash(
  client: pg.Client,
  table: MoveTable,
  after: string | null,
  through: string | null
): Promise<{ rows: number; hash: string }> {
  const where = rangeWhere(table, after, through)
  const result = await client.query(
    `SELECT count(*)::text AS n,
       coalesce(md5(string_agg(md5(${hashedRowText(table, 'mv_r')}), '' ORDER BY ${orderBy(table)})), '') AS h
     FROM ${tableRef(table)} mv_r ${where.sql}`,
    where.params
  )
  return { rows: Number(result.rows[0]?.n ?? 0), hash: String(result.rows[0]?.h ?? '') }
}

async function rangeRowHashes(
  client: pg.Client,
  table: MoveTable,
  after: string | null,
  through: string | null
): Promise<Map<string, string>> {
  const where = rangeWhere(table, after, through)
  const result = await client.query(
    `SELECT ${pkJson(table, 'mv_r')}::text AS pk, md5(${hashedRowText(table, 'mv_r')}) AS h
     FROM ${tableRef(table)} mv_r ${where.sql}`,
    where.params
  )
  return new Map(result.rows.map((row) => [String(row.pk), String(row.h)]))
}

// Row counts and md5 over primary-key ranges cut on the reference side. Every column is hashed by
// name in a fixed order. A range that differs is listed key by key.
export async function verifyMoveTables(
  reference: pg.Client,
  other: pg.Client,
  tables: MoveTable[],
  options: MoveVerifyOptions = {}
): Promise<MoveTableVerdict[]> {
  const chunkRows = options.chunkRows ?? 5_000
  const maxRowsPerSecond = options.maxRowsPerSecond ?? 0
  const maxReportedKeys = options.maxReportedKeys ?? 20
  const startedAt = Date.now()
  let scanned = 0
  const verdicts: MoveTableVerdict[] = []
  for (const table of tables) {
    const verdict: MoveTableVerdict = {
      table: table.name,
      referenceRows: 0,
      otherRows: 0,
      mismatches: []
    }
    let after: string | null = null
    for (;;) {
      const where = rangeWhere(table, after, null)
      const boundary = await reference.query(
        `SELECT ${pkJson(table, 'mv_r')}::text AS pk FROM ${tableRef(table)} mv_r ${where.sql}
         ORDER BY ${orderBy(table)} OFFSET ${chunkRows - 1} LIMIT 1`,
        where.params
      )
      // The last range is open, so rows only the other side has past the end are counted too.
      const through: string | null = boundary.rows[0] ? String(boundary.rows[0].pk) : null
      const [left, right] = await Promise.all([
        rangeHash(reference, table, after, through),
        rangeHash(other, table, after, through)
      ])
      verdict.referenceRows += left.rows
      verdict.otherRows += right.rows
      scanned += left.rows + right.rows
      if (left.hash !== right.hash || left.rows !== right.rows) {
        const [leftRows, rightRows] = await Promise.all([
          rangeRowHashes(reference, table, after, through),
          rangeRowHashes(other, table, after, through)
        ])
        const keys = new Set<string>()
        for (const [pk, hash] of leftRows) if (rightRows.get(pk) !== hash) keys.add(pk)
        for (const pk of rightRows.keys()) if (!leftRows.has(pk)) keys.add(pk)
        verdict.mismatches.push({
          after,
          through,
          referenceRows: left.rows,
          otherRows: right.rows,
          keys: [...keys].slice(0, maxReportedKeys)
        })
      }
      if (maxRowsPerSecond > 0) {
        await sleep((scanned * 1000) / maxRowsPerSecond - (Date.now() - startedAt))
      }
      if (through === null) break
      after = through
    }
    logMoveEvent('verify_table', {
      table: table.name,
      referenceRows: verdict.referenceRows,
      otherRows: verdict.otherRows,
      mismatchedRanges: verdict.mismatches.length,
      ...(verdict.mismatches.length > 0 ? { mismatches: verdict.mismatches } : {})
    })
    verdicts.push(verdict)
  }
  return verdicts
}

export function verdictsEqual(verdicts: MoveTableVerdict[]): boolean {
  return verdicts.every((verdict) => verdict.mismatches.length === 0)
}
