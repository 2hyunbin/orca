import { serialize, deserialize } from 'node:v8'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { JournalRestProjection, type JournalStructuralStorage } from './journal-rest-projection'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'

/** Derived upgrade work only: every cursor and relation commits together, never transcript prose. */
export class JournalStructuralScratch implements JournalStructuralStorage {
  readonly db: Database.Database
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
    return new StructuralMap(this.db, name, codec)
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
  reset(): void {
    this.db.exec('DELETE FROM relations; DELETE FROM context_clears; DELETE FROM checkpoint')
  }
  close(): void {
    this.db.close()
  }
}

class StructuralMap<K, V, Stored = V> extends Map<K, V> {
  private readonly space: Buffer
  constructor(
    private readonly db: Database.Database,
    space: string,
    private readonly codec?: { encode: (value: V) => Stored; decode: (value: Stored) => V },
    private readonly changed?: (key: K, value: V | undefined, previous: V | undefined) => void
  ) {
    super()
    this.space = serialize(space)
  }
  override get(key: K): V | undefined {
    const row = this.db
      .prepare('SELECT value FROM relations WHERE space = ? AND key = ?')
      .get(this.space, serialize(key))
    if (!(row?.value instanceof Uint8Array)) {
      return undefined
    }
    const value = deserialize(Buffer.from(row.value))
    return this.codec ? this.codec.decode(value) : value
  }
  override has(key: K): boolean {
    return !!this.db
      .prepare('SELECT id FROM relations WHERE space = ? AND key = ?')
      .get(this.space, serialize(key))
  }
  override set(key: K, value: V): this {
    const previous = this.changed ? this.get(key) : undefined
    this.db
      .prepare(`INSERT INTO relations(space,key,value) VALUES(?,?,?)
      ON CONFLICT(space,key) DO UPDATE SET value = excluded.value`)
      .run(this.space, serialize(key), serialize(this.codec ? this.codec.encode(value) : value))
    this.changed?.(key, value, previous)
    return this
  }
  override delete(key: K): boolean {
    const previous = this.changed ? this.get(key) : undefined
    this.changed?.(key, undefined, previous)
    return (
      this.db
        .prepare('DELETE FROM relations WHERE space = ? AND key = ?')
        .run(this.space, serialize(key)).changes > 0
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
      yield [deserialize(Buffer.from(row.key)), this.codec ? this.codec.decode(value) : value]
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

export type JournalStructuralCheckpoint = {
  sessionId: string
  guard: string
  cursor: number
  agent?: string
  rest: ReturnType<JournalRestProjection['checkpoint']>
  scope: string | null
  latestAcceptedTurnSequence: number
}

export function structuralJournalState(
  scratch: JournalStructuralScratch,
  sessionId: string,
  epoch: string,
  saved?: JournalStructuralCheckpoint
): JournalReducerState {
  const state = createJournalReducerState(sessionId, epoch)
  const addresses = scratch.map<string, string>('submissionAddresses')
  state.items = new StructuralMap(
    scratch.db,
    'items',
    { encode: structuralItem, decode: (value) => value },
    (key, value) => {
      if (value && isAgentSessionContextClear(value.body)) {
        scratch.db
          .prepare('INSERT OR REPLACE INTO context_clears(key,seq) VALUES(?,?)')
          .run(serialize(key), value.sequence)
      } else {
        scratch.db.prepare('DELETE FROM context_clears WHERE key = ?').run(serialize(key))
      }
    }
  )
  state.itemFences = scratch.map('itemFences')
  state.itemExecutionOwners = scratch.map('itemExecutionOwners')
  state.providerActivityAt = scratch.map('activity')
  state.tombstones = scratch.map('tombstones')
  state.removedTurnIds = scratch.set('removedTurns')
  state.submissions = new StructuralMap<string, AgentJournalSubmission>(
    scratch.db,
    'submissions',
    undefined,
    (key, value, previous) => {
      if (previous) {
        scratch.map(`fingerprint:${previous.payloadFingerprint}`).delete(key)
      }
      if (value) {
        scratch.map(`fingerprint:${value.payloadFingerprint}`).set(key, value)
        addresses.set(agentJournalSubmissionKey(key), key)
      } else {
        addresses.delete(agentJournalSubmissionKey(key))
      }
    }
  )
  state.echoCandidates = (fingerprint) =>
    scratch.map<string, AgentJournalSubmission>(`fingerprint:${fingerprint}`).values()
  state.contextClearSequence = () =>
    Number(
      scratch.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM context_clears').get()?.seq ?? 0
    )
  state.submissionItemSource = (id) => addresses.get(id)
  state.receipts = scratch.map('receipts')
  state.aliases = scratch.map('aliases')
  // Only presence suppresses the old fingerprint rule; unvalidated echo payload is never interpreted.
  state.itemEchoes = scratch.map('echoes', { encode: () => true, decode: () => true })
  state.stoppedHistoryCarried = scratch.map('carried', { encode: () => [], decode: () => [] })
  state.rest = new JournalRestProjection(scratch, saved?.rest)
  state.derivedTurnScope = new JournalDerivedTurnScope(saved?.scope)
  state.lastSequence = saved?.cursor ?? 0
  state.agent = saved?.agent
  state.appliedSettlementIds = scratch.set('settlements')
  state.latestAcceptedTurnSequence = saved?.latestAcceptedTurnSequence ?? 0
  return state
}
