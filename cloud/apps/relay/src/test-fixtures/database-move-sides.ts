import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { applyRelayPostgresSchema, openRelayPostgresPool } from '../database.js'
import { MoveDatabases, type MoveSide } from '../database-move-connections.js'
import {
  PointerGenerationConflict,
  type DatabaseTargetPointerStore,
  type StoredDatabaseTargetPointer
} from '../database-move-pointer-store.js'
import type { DatabaseTargetPointer } from '../relay-database-target-pointer.js'

// Two databases on one test server stand in for the shared and the dedicated instance. Each side
// has its own app and tool role, as the two Cloud SQL instances would; roles are cluster-wide
// here, so distinct names keep a fence on one side from touching the other.
export type MoveTestSide = {
  database: string
  app: { user: string; password: string; url: string }
  move: { user: string; password: string; url: string }
  // Superuser on this side's database: reads what the relay role can no longer log in to see.
  adminUrl: string
}

export type MoveTestSides = Record<MoveSide, MoveTestSide> & {
  databases: () => MoveDatabases
  drop: () => Promise<void>
}

function urlFor(adminUrl: string, user: string, password: string, database: string): string {
  const url = new URL(adminUrl)
  url.username = user
  url.password = password
  url.pathname = `/${database}`
  return url.toString()
}

export async function withPgClient<T>(
  url: string,
  run: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  client.on('error', () => undefined)
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function createMoveTestSides(
  adminUrl: string,
  options: { schemaOn?: MoveSide[] } = {}
): Promise<MoveTestSides> {
  const suffix = randomBytes(4).toString('hex')
  const make = (side: MoveSide): MoveTestSide => {
    const tag = side === 'primary' ? 'p' : 'd'
    const database = `mv_${tag}_${suffix}`
    const app = { user: `mv_${tag}_app_${suffix}`, password: randomBytes(12).toString('hex') }
    const move = { user: `mv_${tag}_tool_${suffix}`, password: randomBytes(12).toString('hex') }
    return {
      database,
      app: { ...app, url: urlFor(adminUrl, app.user, app.password, database) },
      move: { ...move, url: urlFor(adminUrl, move.user, move.password, database) },
      adminUrl: (() => {
        const url = new URL(adminUrl)
        url.pathname = `/${database}`
        return url.toString()
      })()
    }
  }
  const sides = { primary: make('primary'), dedicated: make('dedicated') }
  await withPgClient(adminUrl, async (admin) => {
    for (const side of Object.values(sides)) {
      // No CREATEROLE: the fence must work for a role that can only change itself.
      await admin.query(
        `CREATE ROLE ${side.app.user} LOGIN NOCREATEROLE PASSWORD '${side.app.password}'`
      )
      await admin.query(
        `CREATE ROLE ${side.move.user} LOGIN NOCREATEROLE PASSWORD '${side.move.password}'`
      )
      await admin.query(`CREATE DATABASE ${side.database} OWNER ${side.app.user}`)
    }
  })
  for (const name of options.schemaOn ?? ['primary']) {
    const connection = { connectionString: sides[name].app.url }
    const { database } = openRelayPostgresPool(connection, { poolMax: 1 })
    try {
      await applyRelayPostgresSchema(connection, undefined, database)
    } finally {
      await database.close()
    }
  }
  return {
    ...sides,
    databases: () =>
      new MoveDatabases(
        {
          primary: { app: { url: sides.primary.app.url }, move: { url: sides.primary.move.url } },
          dedicated: {
            app: { url: sides.dedicated.app.url },
            move: { url: sides.dedicated.move.url }
          }
        },
        null
      ),
    drop: async () => {
      await withPgClient(adminUrl, async (admin) => {
        for (const side of Object.values(sides)) {
          await admin.query(`DROP DATABASE IF EXISTS ${side.database} WITH (FORCE)`)
          await admin.query(`DROP ROLE IF EXISTS ${side.app.user}`)
          await admin.query(`DROP ROLE IF EXISTS ${side.move.user}`)
        }
      })
    }
  }
}

// The pointer object in memory, with the same generation preconditions as Cloud Storage.
export class MemoryPointerStore implements DatabaseTargetPointerStore {
  private generation = 1
  constructor(private stored: StoredDatabaseTargetPointer | null) {}
  current(): DatabaseTargetPointer | null {
    return this.stored ? structuredClone(this.stored.pointer) : null
  }
  async read(): Promise<StoredDatabaseTargetPointer | null> {
    return this.stored ? structuredClone(this.stored) : null
  }
  async write(pointer: DatabaseTargetPointer, ifGenerationMatch: string): Promise<string> {
    if (this.stored?.generation !== ifGenerationMatch) throw new PointerGenerationConflict()
    this.generation += 1
    this.stored = { pointer: structuredClone(pointer), generation: String(this.generation) }
    return this.stored.generation
  }
  async delete(ifGenerationMatch: string): Promise<void> {
    if (this.stored?.generation !== ifGenerationMatch) throw new PointerGenerationConflict()
    this.stored = null
  }
}

export function testPointerStore(): MemoryPointerStore {
  return new MemoryPointerStore({
    generation: '1',
    pointer: {
      version: 1,
      dedicated: {
        instanceConnectionName: 'test-project:us-central1:relay-db',
        databaseUrlSecret: 'projects/test-project/secrets/relay-db-url/versions/latest'
      }
    }
  })
}
