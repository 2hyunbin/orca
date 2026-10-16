import pg from 'pg'
import { relayPostgresSchemaStatements } from './database.js'
import { MoveRefusal } from './database-move-events.js'

export type MoveColumn = { name: string; type: string; notNull: boolean; generated: boolean }
export type MoveForeignKey = { columns: string[]; parent: string; parentColumns: string[] }
export type MoveTable = {
  name: string
  columns: MoveColumn[]
  primaryKey: string[]
  // Non-primary unique constraints and plain unique indexes (no predicate, no expression).
  uniqueKeys: string[][]
  foreignKeys: MoveForeignKey[]
}

export const RELAY_DATABASE_AUTHORITY_TABLE = 'relay_database_authority'
const MOVE_TABLE_PREFIX = 'relay_move_'
// No longer created by the schema; left empty on databases that have them.
const RETIRED_RELAY_TABLES = new Set([
  'relay_confirmable_splices',
  'relay_cell_drain_attempts',
  'relay_migration_leases'
])

const CATALOG_SQL = `
SELECT c.relname AS name,
  (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
     'notNull', a.attnotnull, 'generated', a.attgenerated <> '') ORDER BY a.attnum)
   FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT json_agg(a.attname ORDER BY k.ord)
   FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_key,
  (SELECT coalesce(json_agg(u.cols), '[]'::json) FROM (
     SELECT (SELECT json_agg(a.attname ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
     FROM pg_index i
     WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL
       AND i.indexprs IS NULL) u) AS unique_keys,
  (SELECT coalesce(json_agg(json_build_object(
       'parent', p.relname,
       'columns', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum),
       'parentColumns', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(f.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.attnum))), '[]'::json)
   FROM pg_constraint f JOIN pg_class p ON p.oid = f.confrelid
   WHERE f.conrelid = c.oid AND f.contype = 'f') AS foreign_keys
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname`

export function quoteIdent(name: string): string {
  return pg.escapeIdentifier(name)
}

export function quoteLiteral(value: string): string {
  return pg.escapeLiteral(value)
}

function isMoveCandidate(name: string): boolean {
  return (
    name !== RELAY_DATABASE_AUTHORITY_TABLE &&
    !name.startsWith(MOVE_TABLE_PREFIX) &&
    !RETIRED_RELAY_TABLES.has(name)
  )
}

// The tables the schema creates, read from the statements the relay itself applies.
export function relaySchemaTableNames(statements = relayPostgresSchemaStatements()): string[] {
  const names = new Set<string>()
  for (const statement of statements) {
    for (const match of statement.matchAll(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi
    )) {
      if (match[1] && isMoveCandidate(match[1])) names.add(match[1])
    }
  }
  return [...names].sort()
}

// Every relay table that moves, in parent-before-child order. Refuses when the database and the
// schema disagree about which tables exist, or a table cannot be keyed.
export async function readMoveTables(
  client: pg.Client,
  schemaTables = relaySchemaTableNames()
): Promise<MoveTable[]> {
  const result = await client.query(CATALOG_SQL)
  const tables: MoveTable[] = []
  for (const row of result.rows) {
    const name = String(row.name)
    if (!isMoveCandidate(name)) continue
    tables.push({
      name,
      columns: row.columns ?? [],
      primaryKey: row.primary_key ?? [],
      uniqueKeys: row.unique_keys ?? [],
      foreignKeys: row.foreign_keys ?? []
    })
  }
  const present = tables.map((table) => table.name)
  const missing = schemaTables.filter((name) => !present.includes(name))
  const unexpected = present.filter((name) => !schemaTables.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new MoveRefusal('table_list_differs_from_schema', { missing, unexpected })
  }
  const unkeyed = tables.filter((table) => table.primaryKey.length === 0).map((table) => table.name)
  const generated = tables.filter((table) => table.columns.some((column) => column.generated))
  if (unkeyed.length > 0 || generated.length > 0) {
    throw new MoveRefusal('table_not_movable', {
      withoutPrimaryKey: unkeyed,
      withGeneratedColumns: generated.map((table) => table.name)
    })
  }
  return orderParentsFirst(tables)
}

function orderParentsFirst(tables: MoveTable[]): MoveTable[] {
  const byName = new Map(tables.map((table) => [table.name, table]))
  const ordered: MoveTable[] = []
  const visiting = new Set<string>()
  const visit = (table: MoveTable): void => {
    if (ordered.includes(table)) return
    if (visiting.has(table.name)) throw new MoveRefusal('foreign_key_cycle', { table: table.name })
    visiting.add(table.name)
    for (const key of table.foreignKeys) {
      const parent = byName.get(key.parent)
      if (!parent) throw new MoveRefusal('foreign_key_parent_not_moved', { table: table.name })
      if (parent !== table) visit(parent)
    }
    visiting.delete(table.name)
    ordered.push(table)
  }
  for (const table of tables) visit(table)
  return ordered
}

// What a row's copy depends on, independent of column position.
export function moveTableShape(table: MoveTable): string {
  return JSON.stringify({
    columns: [...table.columns]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((column) => [column.name, column.type, column.notNull]),
    primaryKey: table.primaryKey,
    uniqueKeys: table.uniqueKeys.map((key) => key.join(',')).sort(),
    foreignKeys: table.foreignKeys
      .map((key) => `${key.columns.join(',')}>${key.parent}(${key.parentColumns.join(',')})`)
      .sort()
  })
}

// Names, types, nullability, keys and the database collation (which orders text keys): what the
// copy, the sync and the range hashes depend on being the same on both sides.
export async function compareMoveSchemas(
  primary: { client: pg.Client; tables: MoveTable[] },
  dedicated: { client: pg.Client; tables: MoveTable[] }
): Promise<void> {
  const shape = moveTableShape
  const dedicatedShapes = new Map(dedicated.tables.map((table) => [table.name, shape(table)]))
  const drifted = primary.tables
    .filter((table) => dedicatedShapes.get(table.name) !== shape(table))
    .map((table) => table.name)
  const collation = async (client: pg.Client): Promise<string> =>
    String(
      (
        await client.query(
          `SELECT datcollate || '/' || datctype AS collation FROM pg_database WHERE datname = current_database()`
        )
      ).rows[0]?.collation
    )
  const [primaryCollation, dedicatedCollation] = await Promise.all([
    collation(primary.client),
    collation(dedicated.client)
  ])
  if (drifted.length > 0 || primaryCollation !== dedicatedCollation) {
    throw new MoveRefusal('schema_drift', {
      tables: drifted,
      ...(primaryCollation === dedicatedCollation ? {} : { collation: 'differs' })
    })
  }
}

// SQL fragments keyed to one table. `alias` is a row source in the statement.
export function pkTuple(table: MoveTable, alias: string): string {
  return `(${table.primaryKey.map((column) => `${alias}.${quoteIdent(column)}`).join(', ')})`
}

// Keys in (after, through] for rows aliased mv_r; null = open end. Parameters start at $1.
export function pkRange(
  table: MoveTable,
  after: string | null,
  through: string | null
): { clauses: string[]; params: string[] } {
  const params: string[] = []
  const clauses: string[] = []
  const columns = table.primaryKey.map((column) => `mv_k.${quoteIdent(column)}`).join(', ')
  for (const [op, value] of [
    ['>', after],
    ['<=', through]
  ] as const) {
    if (value === null) continue
    params.push(value)
    clauses.push(
      `${pkTuple(table, 'mv_r')} ${op} (SELECT ${columns} FROM ${jsonRecord(table, params.length)} mv_k)`
    )
  }
  return { clauses, params }
}

export function columnTuple(columns: string[], alias: string): string {
  return `(${columns.map((column) => `${alias}.${quoteIdent(column)}`).join(', ')})`
}

// jsonb text is canonical, so the same key always prints the same way on both sides.
export function pkJson(table: MoveTable, alias: string): string {
  const pairs = table.primaryKey.map(
    (column) => `${quoteLiteral(column)}, ${alias}.${quoteIdent(column)}`
  )
  return `jsonb_build_object(${pairs.join(', ')})`
}

// Rows of the table's own type from a JSON array parameter: values are parsed by Postgres,
// never by JavaScript, so BIGINTs keep every digit.
export function jsonRecords(table: MoveTable, parameter: number): string {
  return `jsonb_populate_recordset(null::public.${quoteIdent(table.name)}, $${parameter}::jsonb)`
}

export function jsonRecord(table: MoveTable, parameter: number): string {
  return `jsonb_populate_record(null::public.${quoteIdent(table.name)}, $${parameter}::jsonb)`
}

export function tableRef(table: MoveTable): string {
  return `public.${quoteIdent(table.name)}`
}

// Hash input: every column by name, in name order, so column position never matters.
export function hashedRowText(table: MoveTable, alias: string): string {
  const names = table.columns.map((column) => column.name).sort()
  return `ROW(${names.map((name) => `${alias}.${quoteIdent(name)}`).join(', ')})::text`
}

export function jsonArray(items: string[]): string {
  return `[${items.join(',')}]`
}
