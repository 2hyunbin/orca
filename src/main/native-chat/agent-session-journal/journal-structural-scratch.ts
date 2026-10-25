export type { JournalStructuralCheckpoint } from './journal-structural-scratch-encoding'
import {
  JournalScratchNamespaces,
  encodeStructuralScratchKey,
  decodeStructuralScratchKey,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch-encoding'
import { JournalSelection } from './journal-selection'
import { bindJournalSelection } from './journal-selection-binding'
import { serialize, deserialize } from 'node:v8'
import Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { JournalRestProjection, type JournalStructuralStorage } from './journal-rest-projection'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'

/** Derived upgrade work only: every cursor and relation commits together, never transcript prose. */
export class JournalStructuralScratch implements JournalStructuralStorage {
  readonly db: Database.Database
  private readonly namespaces = new JournalScratchNamespaces()
  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`PRAGMA cache_size = -1024; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY, space BLOB NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL,
        UNIQUE(space, key));
      CREATE INDEX IF NOT EXISTS relation_cursor ON relations(space,id);
      CREATE TABLE IF NOT EXISTS context_clears (key BLOB PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS context_clear_sequence ON context_clears(seq);
      CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), value BLOB NOT NULL)`)
  }
  map<K, V, Stored = V>(
    name: string,
    codec?: { encode: (value: V) => Stored; decode: (value: Stored) => V }
  ): Map<K, V> {
    return new StructuralMap(this.db, this.namespaces.bind(name), codec)
  }
  set<T>(name: string): Set<T> {
    return new StructuralSet(this.map<T, true>(name))
  }
  load<T>(): T | undefined {
    const value = this.db.prepare('SELECT value FROM checkpoint WHERE id = 1').get()?.value
    return value instanceof Uint8Array ? deserialize(Buffer.from(value)) : undefined
  }
  save(value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO checkpoint(id,value) VALUES(1,?)').run(serialize(value))
  }
  beginCleanup(sessionId: string): void {
    this.save({ cleanup: true, sessionId })
  }

  cleanupStep(limit = 32, canWork: () => boolean = () => true): boolean {
    if (!canWork()) {
      return false
    }
    const rows = this.db.prepare('SELECT id FROM relations ORDER BY id LIMIT ?').all(limit)
    const remove = this.db.prepare('DELETE FROM relations WHERE id = ?')
    for (const row of rows) {
      if (!canWork()) {
        return false
      }
      remove.run(row.id)
    }
    if (rows.length !== 0) {
      return false
    }
    if (!canWork()) {
      return false
    }
    const clears = this.db.prepare('SELECT key FROM context_clears ORDER BY key LIMIT ?').all(limit)
    const removeClear = this.db.prepare('DELETE FROM context_clears WHERE key = ?')
    for (const row of clears) {
      if (!canWork()) {
        return false
      }
      removeClear.run(row.key)
    }
    if (clears.length !== 0) {
      return false
    }
    if (!canWork()) {
      return false
    }
    this.db.prepare('DELETE FROM checkpoint WHERE id = 1').run()
    return true
  }
  close(): void {
    this.namespaces.clear()
    this.db.close()
  }
}

class StructuralMap<K, V, Stored = V> extends Map<K, V> {
  constructor(
    private readonly db: Database.Database,
    private readonly space: Buffer,
    private readonly codec?: { encode: (value: V) => Stored; decode: (value: Stored) => V },
    private readonly changed?: (key: K, value: V | undefined, previous: V | undefined) => void
  ) {
    super()
  }
  override get(key: K): V | undefined {
    const row = this.db
      .prepare('SELECT value FROM relations WHERE space = ? AND key = ?')
      .get(this.space, encodeStructuralScratchKey(key))
    if (!(row?.value instanceof Uint8Array)) {
      return undefined
    }
    const value = deserialize(Buffer.from(row.value))
    return this.codec ? this.codec.decode(value) : value
  }
  override has(key: K): boolean {
    return !!this.db
      .prepare('SELECT id FROM relations WHERE space = ? AND key = ?')
      .get(this.space, encodeStructuralScratchKey(key))
  }
  override set(key: K, value: V): this {
    const previous = this.changed ? this.get(key) : undefined
    this.db
      .prepare(`INSERT INTO relations(space,key,value) VALUES(?,?,?)
      ON CONFLICT(space,key) DO UPDATE SET value = excluded.value`)
      .run(
        this.space,
        encodeStructuralScratchKey(key),
        serialize(this.codec ? this.codec.encode(value) : value)
      )
    this.changed?.(key, value, previous)
    return this
  }
  override delete(key: K): boolean {
    const previous = this.changed ? this.get(key) : undefined
    this.changed?.(key, undefined, previous)
    return (
      this.db
        .prepare('DELETE FROM relations WHERE space = ? AND key = ?')
        .run(this.space, encodeStructuralScratchKey(key)).changes > 0
    )
  }
  override clear(): void {
    this.db.prepare('DELETE FROM relations WHERE space = ?').run(this.space)
  }
  override get size(): number {
    return Number(
      this.db.prepare('SELECT COUNT(*) AS n FROM relations WHERE space = ?').get(this.space)?.n ?? 0
    )
  }
  override *entries(): MapIterator<[K, V]> {
    let after = 0
    for (;;) {
      const row = this.db
        .prepare(
          'SELECT id,key,value FROM relations WHERE space = ? AND id > ? ORDER BY id LIMIT 1'
        )
        .get(this.space, after)
      if (
        typeof row?.id !== 'number' ||
        !(row.key instanceof Uint8Array) ||
        !(row.value instanceof Uint8Array)
      ) {
        return
      }
      after = row.id
      const value = deserialize(Buffer.from(row.value))
      // SAFETY: the namespace owner writes K and the reversible key codec preserves that domain.
      const key = decodeStructuralScratchKey(row.key) as K
      yield [key, this.codec ? this.codec.decode(value) : value]
    }
  }
  override [Symbol.iterator]() {
    return this.entries()
  }
  override *keys(): MapIterator<K> {
    for (const [key] of this) {
      yield key
    }
  }
  override *values(): MapIterator<V> {
    for (const [, value] of this) {
      yield value
    }
  }
}

class StructuralSet<T> extends Set<T> {
  constructor(private readonly rows: Map<T, true>) {
    super()
  }
  override add(value: T): this {
    this.rows.set(value, true)
    return this
  }
  override has(value: T): boolean {
    return this.rows.has(value)
  }
  override delete(value: T): boolean {
    return this.rows.delete(value)
  }
  override clear(): void {
    this.rows.clear()
  }
  override get size(): number {
    return this.rows.size
  }
  override values(): SetIterator<T> {
    return this.rows.keys()
  }
  override keys(): SetIterator<T> {
    return this.values()
  }
  override *entries(): SetIterator<[T, T]> {
    for (const value of this.values()) {
      yield [value, value]
    }
  }
  override [Symbol.iterator]() {
    return this.values()
  }
}

/** Only metadata read by the canonical fold survives a transient validated payload. */
function structuralItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  const body = item.body
  const turn = readAgentJournalTurn(body)
  if (body.kind === 'semantic-work') {
    return item
  }
  if (body.kind === 'message') {
    return {
      ...item,
      body: {
        kind: 'message',
        role: body.role,
        blocks: [],
        ...(body.command ? { command: { name: body.command.name } } : {})
      }
    }
  }
  const lifecycle = turn && {
    turnId: turn.turnId,
    state: turn.state,
    outcome: turn.outcome,
    userItemId: turn.userItemId,
    startedAt: turn.startedAt,
    requestedAt: turn.requestedAt,
    completedAt: turn.completedAt
  }
  return {
    ...item,
    body: {
      kind: 'status',
      text: '',
      ...(body.kind === 'status' && body.contextClear ? { contextClear: body.contextClear } : {}),
      ...(lifecycle ? { turnLifecycle: lifecycle } : {})
    }
  }
}

export function structuralJournalState(
  scratch: JournalStructuralScratch,
  sessionId: string,
  epoch: string,
  saved?: JournalStructuralCheckpoint
): JournalReducerState {
  const state = createJournalReducerState(sessionId, epoch)
  state.selection = new JournalSelection(scratch)
  state.selection.deferred = true
  state.items = scratch.map('items', { encode: structuralItem, decode: (value) => value })
  state.itemFences = scratch.map('itemFences')
  state.itemExecutionOwners = scratch.map('itemExecutionOwners')
  state.providerActivityAt = scratch.map('activity')
  state.tombstones = scratch.map('tombstones')
  state.removedTurnIds = scratch.set('removedTurns')
  state.submissions = scratch.map('submissions')
  state.receipts = scratch.map('receipts')
  state.aliases = scratch.map('aliases')
  // Only presence suppresses the old fingerprint rule; unvalidated echo payload is never interpreted.
  state.itemEchoes = scratch.map('echoes', { encode: () => true, decode: () => true })
  state.stoppedHistoryCarried = scratch.map('carried', { encode: () => [], decode: () => [] })
  state.queuedHandOffPlaces = scratch.map('queuedHandOffPlaces')
  state.normalizedHandOffs = scratch.set('normalizedHandOffs')
  state.queue = {
    revision: saved?.queueRevision ?? 0,
    cards: scratch.map('queuedCards', {
      encode: (card) => ({
        ...card,
        body: {
          kind: 'message' as const,
          role: card.body.role,
          blocks: [],
          ...(card.body.command ? { command: { name: card.body.command.name } } : {})
        }
      }),
      decode: (card) => card
    })
  }
  state.rest = new JournalRestProjection(scratch, saved?.rest, state.selection)
  state.derivedTurnScope = new JournalDerivedTurnScope(saved?.scope)
  state.lastSequence = saved?.pending?.sequence ?? saved?.cursor ?? 0
  state.agent = saved?.agent
  state.appliedSettlementIds = scratch.set('settlements')
  state.latestAcceptedTurnSequence = saved?.latestAcceptedTurnSequence ?? 0
  return bindJournalSelection(state)
}
