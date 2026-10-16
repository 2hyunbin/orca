import type pg from 'pg'
import {
  jsonArray,
  jsonRecord,
  jsonRecords,
  pkJson,
  pkRange,
  pkTuple,
  quoteIdent,
  tableRef,
  type MoveTable
} from './database-move-catalog.js'

// Rows travel as Postgres-made JSON text (row_to_json) and are rebuilt by Postgres
// (jsonb_populate_recordset), so no value is ever parsed in JavaScript.
export type MoveTableChanges = {
  // pk JSON text -> row JSON text, both as Postgres printed them.
  upserts: Map<string, string>
  deletes: Set<string>
}
export type MoveChanges = Map<string, MoveTableChanges>
export type MoveKey = { table: string; pk: string }

function list(columns: string[], alias: string): string {
  return columns.map((column) => `${alias}.${quoteIdent(column)}`).join(', ')
}

function tuple(columns: string[], alias: string): string {
  return `(${list(columns, alias)})`
}

export function changesFor(changes: MoveChanges, table: string): MoveTableChanges {
  let entry = changes.get(table)
  if (!entry) {
    entry = { upserts: new Map(), deletes: new Set() }
    changes.set(table, entry)
  }
  return entry
}

function rowsToChanges(rows: Array<Record<string, unknown>>, target: Map<string, string>): number {
  let bytes = 0
  for (const row of rows) {
    const pk = String(row.pk)
    const json = String(row.row)
    bytes += json.length
    if (!target.has(pk)) target.set(pk, json)
  }
  return bytes
}

// Current source rows for these keys; a key with no row is a delete.
export async function readSourceRows(
  source: pg.Client,
  table: MoveTable,
  pks: string[],
  changes: MoveChanges
): Promise<number> {
  const entry = changesFor(changes, table.name)
  const result = await source.query(
    `SELECT ${pkJson(table, 'mv_r')}::text AS pk, row_to_json(mv_r)::text AS row
     FROM ${tableRef(table)} mv_r
     WHERE ${pkTuple(table, 'mv_r')} IN (SELECT ${list(table.primaryKey, 'mv_k')} FROM ${jsonRecords(table, 1)} mv_k)`,
    [jsonArray(pks)]
  )
  const bytes = rowsToChanges(result.rows, entry.upserts)
  for (const pk of pks) if (!entry.upserts.has(pk)) entry.deletes.add(pk)
  return bytes
}

// The next keyset page of a table, after `afterPk` (pk JSON text) or from the start.
export async function readSourcePage(
  source: pg.Client,
  table: MoveTable,
  afterPk: string | null,
  limit: number,
  changes: MoveChanges
): Promise<{ rows: number; bytes: number; lastPk: string | null; pks: string[] }> {
  const after =
    afterPk === null
      ? ''
      : `WHERE ${pkTuple(table, 'mv_r')} > (SELECT ${list(table.primaryKey, 'mv_k')} FROM ${jsonRecord(table, 2)} mv_k)`
  const result = await source.query(
    `SELECT ${pkJson(table, 'mv_r')}::text AS pk, row_to_json(mv_r)::text AS row
     FROM ${tableRef(table)} mv_r ${after}
     ORDER BY ${list(table.primaryKey, 'mv_r')} LIMIT $1`,
    afterPk === null ? [limit] : [limit, afterPk]
  )
  const bytes = rowsToChanges(result.rows, changesFor(changes, table.name).upserts)
  const pks = result.rows.map((row) => String(row.pk))
  return { rows: pks.length, bytes, lastPk: pks.at(-1) ?? null, pks }
}

// Target rows in a copied page's key range that the source page lacks: deleted on the source
// while their keys were not tracked (before tracking, or after a lost dirty set).
export async function addTargetStrays(
  target: pg.Client,
  table: MoveTable,
  range: { after: string | null; through: string | null; pagePks: string[] },
  changes: MoveChanges
): Promise<void> {
  const { clauses, params } = pkRange(table, range.after, range.through)
  const page = params.length + 1
  const result = await target.query(
    `SELECT ${pkJson(table, 'mv_r')}::text AS pk FROM ${tableRef(table)} mv_r
     WHERE ${[
       ...clauses,
       `${pkTuple(table, 'mv_r')} NOT IN (SELECT ${list(table.primaryKey, 'mv_k')} FROM ${jsonRecords(table, page)} mv_k)`
     ].join(' AND ')}`,
    [...params, jsonArray(range.pagePks)]
  )
  const entry = changesFor(changes, table.name)
  for (const row of result.rows) entry.deletes.add(String(row.pk))
}

// A child row can only land after its parent does, so every upserted child brings the parent row
// it references, read in the same source snapshot. Children are visited first so a parent that is
// itself a child brings its own parent too.
export async function addReferencedParents(
  source: pg.Client,
  tables: MoveTable[],
  changes: MoveChanges
): Promise<number> {
  const byName = new Map(tables.map((table) => [table.name, table]))
  let bytes = 0
  for (const table of tables.toReversed()) {
    const childRows = [...(changes.get(table.name)?.upserts.values() ?? [])]
    if (childRows.length === 0) continue
    for (const key of table.foreignKeys) {
      const parent = byName.get(key.parent)
      if (!parent) continue
      const result = await source.query(
        `SELECT ${pkJson(parent, 'mv_p')}::text AS pk, row_to_json(mv_p)::text AS row
         FROM ${tableRef(parent)} mv_p
         WHERE ${tuple(key.parentColumns, 'mv_p')} IN (SELECT ${list(key.columns, 'mv_c')} FROM ${jsonRecords(table, 1)} mv_c)`,
        [jsonArray(childRows)]
      )
      const entry = changesFor(changes, parent.name)
      bytes += rowsToChanges(result.rows, entry.upserts)
      for (const row of result.rows) entry.deletes.delete(String(row.pk))
    }
  }
  return bytes
}

// Applies one batch inside the caller's open target transaction: deletes children first, then
// upserts parents first. Rows the target holds that block a change (a stale child of a deleted
// parent, or a stale row holding a unique value the source now gives another key) are deleted and
// handed to `markDirty`, so the next sync pass copies whatever the source still has for them.
export async function applyMoveChanges(
  target: pg.Client,
  tables: MoveTable[],
  changes: MoveChanges,
  markDirty: (keys: MoveKey[]) => Promise<void>
): Promise<{ upserted: number; deleted: number; displaced: number }> {
  const displaced: MoveKey[] = []
  let deleted = 0
  let upserted = 0

  const deleteKeys = async (table: MoveTable, pks: string[], displace: boolean): Promise<void> => {
    if (pks.length === 0) return
    for (const child of tables) {
      for (const key of child.foreignKeys.filter((foreign) => foreign.parent === table.name)) {
        const children = await target.query(
          `SELECT ${pkJson(child, 'mv_c')}::text AS pk FROM ${tableRef(child)} mv_c
           WHERE ${tuple(key.columns, 'mv_c')} IN (SELECT ${list(key.parentColumns, 'mv_k')} FROM ${jsonRecords(table, 1)} mv_k)`,
          [jsonArray(pks)]
        )
        await deleteKeys(
          child,
          children.rows.map((row) => String(row.pk)),
          true
        )
      }
    }
    const result = await target.query(
      `DELETE FROM ${tableRef(table)} mv_t
       WHERE ${pkTuple(table, 'mv_t')} IN (SELECT ${list(table.primaryKey, 'mv_k')} FROM ${jsonRecords(table, 1)} mv_k)`,
      [jsonArray(pks)]
    )
    deleted += result.rowCount ?? 0
    if (displace) displaced.push(...pks.map((pk) => ({ table: table.name, pk })))
  }

  for (const table of tables.toReversed()) {
    await deleteKeys(table, [...(changes.get(table.name)?.deletes ?? [])], false)
  }
  for (const table of tables) {
    const rows = [...(changes.get(table.name)?.upserts.values() ?? [])]
    if (rows.length === 0) continue
    const incoming = jsonArray(rows)
    // A target row holding an incoming unique value is stale unless it is that same incoming row
    // with that same value; this also clears values two incoming rows swap.
    for (const unique of table.uniqueKeys) {
      const sameRow = [...table.primaryKey, ...unique]
        .map(
          (column) => `mv_s.${quoteIdent(column)} IS NOT DISTINCT FROM mv_t.${quoteIdent(column)}`
        )
        .join(' AND ')
      const colliding = await target.query(
        `SELECT ${pkJson(table, 'mv_t')}::text AS pk FROM ${tableRef(table)} mv_t
         WHERE ${tuple(unique, 'mv_t')} IN (SELECT ${list(unique, 'mv_r')} FROM ${jsonRecords(table, 1)} mv_r)
           AND NOT EXISTS (SELECT 1 FROM ${jsonRecords(table, 1)} mv_s WHERE ${sameRow})`,
        [incoming]
      )
      await deleteKeys(
        table,
        colliding.rows.map((row) => String(row.pk)),
        true
      )
    }
    const updatable = table.columns.filter((column) => !table.primaryKey.includes(column.name))
    const onConflict =
      updatable.length === 0
        ? 'DO NOTHING'
        : `DO UPDATE SET ${updatable.map((column) => `${quoteIdent(column.name)} = EXCLUDED.${quoteIdent(column.name)}`).join(', ')}`
    const result = await target.query(
      `INSERT INTO ${tableRef(table)} SELECT * FROM ${jsonRecords(table, 1)}
       ON CONFLICT (${table.primaryKey.map(quoteIdent).join(', ')}) ${onConflict}`,
      [incoming]
    )
    upserted += result.rowCount ?? 0
  }
  if (displaced.length > 0) await markDirty(displaced)
  return { upserted, deleted, displaced: displaced.length }
}
