import { mailLineageGraph, type MailLineageScope } from './journal-mail-lineage'
export { mailLineageGraph, mailLineageValue, type MailLineageScope } from './journal-mail-lineage'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import type { JournalOperationReceipt } from './journal-row-writer'

export type MailHoldFacts = {
  scope?: MailLineageScope
  members: ReadonlySet<string>
  ambiguous: boolean
  key: string
}
export type MailStopCapture = { members?: readonly string[]; finished?: () => void }
export type CaptureSessionMail = (
  sessionId: string,
  records: readonly AgentSessionRecord[],
  scope?: MailLineageScope | null
) => MailStopCapture
export type MailHoldState = { version: 1 } & (
  | { status: 'released' }
  | { status: 'held'; members: string[]; ambiguous: boolean; releasedThrough: number }
)
const caches = new WeakMap<
  Database.Database,
  {
    revision: number
    graph: Map<string, MailLineageScope | null>
    facts: Map<MailLineageScope, MailHoldFacts>
  }
>()

export function ambiguousMailAfterStopPolicy(): boolean {
  return false // Pending product decision: ambiguous mail waits for actual person Send/Resume.
}
export function mailAdmissionPermission(
  facts: MailHoldFacts | undefined,
  members: readonly string[]
): boolean {
  if (!facts) {
    return ambiguousMailAfterStopPolicy()
  }
  return Boolean(
    facts &&
    (!facts.ambiguous || ambiguousMailAfterStopPolicy()) &&
    !members.some((id) => facts.members.has(id))
  )
}
export function mailHoldAliases(
  sessionId: string,
  records: readonly AgentSessionRecord[]
): string[] | null {
  return mailLineageGraph(records).get(sessionId)?.aliases ?? null
}
export function readMailHoldRecords(db: Database.Database): AgentSessionRecord[] {
  return db
    .prepare('SELECT record_json FROM agent_session_records')
    .all()
    .map((row) => {
      const value: unknown = JSON.parse(String(row.record_json))
      if (!isPersistedAgentSessionRecord(value)) {
        throw new Error('unreadable mail recipient')
      }
      return decodePersistedAgentSessionRecord(value).record
    })
}
function decode(value: unknown): MailHoldState | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('status' in value)
  ) {
    return null
  }
  if (value.status === 'released') {
    return { version: 1, status: 'released' }
  }
  if (
    value.status !== 'held' ||
    !('members' in value) ||
    !Array.isArray(value.members) ||
    !value.members.every((id) => typeof id === 'string') ||
    !('ambiguous' in value) ||
    typeof value.ambiguous !== 'boolean' ||
    !('releasedThrough' in value) ||
    !Number.isSafeInteger(value.releasedThrough) ||
    Number(value.releasedThrough) < 0
  ) {
    return null
  }
  return {
    version: 1,
    status: 'held',
    members: value.members,
    ambiguous: value.ambiguous,
    releasedThrough: Number(value.releasedThrough)
  }
}
function fold(db: Database.Database, aliases: readonly string[] | null) {
  let release = 0
  let missing = !aliases
  const unknownOrders: number[] = []
  const holds: { order: number; state: Extract<MailHoldState, { status: 'held' }> }[] = []
  for (const alias of aliases ?? []) {
    const row = db
      .prepare('SELECT intent_order, state_json FROM agent_session_mail_holds WHERE session_id = ?')
      .get(alias)
    if (!row) {
      missing = true
      continue
    }
    const order = Number(row.intent_order)
    let state: MailHoldState | null = null
    try {
      state = decode(JSON.parse(String(row.state_json)))
    } catch {
      /* Missing evidence remains ambiguous. */
    }
    if (
      !state ||
      !Number.isSafeInteger(order) ||
      order <= 0 ||
      (state.status === 'held' && state.releasedThrough >= order)
    ) {
      unknownOrders.push(Number.isSafeInteger(order) && order > 0 ? order : Infinity)
      continue
    }
    if (state.status === 'released') {
      release = Math.max(release, order)
    } else {
      release = Math.max(release, state.releasedThrough)
      holds.push({ order, state })
    }
  }
  const active = holds.filter((hold) => hold.order > release)
  return {
    release,
    members: new Set(active.flatMap((hold) => hold.state.members)),
    ambiguous:
      (missing && release === 0) ||
      unknownOrders.some((order) => order > release) ||
      active.some((hold) => hold.state.ambiguous)
  }
}
function mailLineageCache(
  db: Database.Database,
  records: () => readonly AgentSessionRecord[],
  revision: number
) {
  let cache = caches.get(db)
  if (!cache || revision < 0 || cache.revision !== revision) {
    cache = { revision, graph: mailLineageGraph(records()), facts: new Map() }
    caches.set(db, cache)
  }
  return cache
}
export function readMailLineageScope(
  db: Database.Database,
  sessionId: string,
  records: () => readonly AgentSessionRecord[],
  revision: number
): MailLineageScope | null {
  return mailLineageCache(db, records, revision).graph.get(sessionId) ?? null
}
export function readMailHoldFacts(
  db: Database.Database,
  sessionId: string,
  records: () => readonly AgentSessionRecord[],
  recordsRevision: number
): MailHoldFacts {
  try {
    const cache = mailLineageCache(db, records, recordsRevision)
    const scope = cache.graph.get(sessionId)
    if (scope) {
      const prior = cache.facts.get(scope)
      if (prior) {
        return prior
      }
    }
    const facts = fold(db, scope?.aliases ?? null)
    const result = {
      ...facts,
      ...(scope ? { scope } : {}),
      key: createHash('sha256')
        .update(
          JSON.stringify([scope?.aliases, facts.release, facts.ambiguous, [...facts.members]])
        )
        .digest('hex')
    }
    if (scope) {
      cache.facts.set(scope, result)
    }
    return result
  } catch {
    caches.delete(db)
    return { members: new Set(), ambiguous: true, key: 'unreadable' }
  }
}
export function writeMailHold(
  db: Database.Database,
  sessionId: string,
  state: MailHoldState,
  fresh = false
): void {
  const order = Number(
    db
      .prepare('SELECT COALESCE(MAX(intent_order), 0) + 1 AS next FROM agent_session_mail_holds')
      .get()?.next
  )
  if (!Number.isSafeInteger(order) || order <= 0) {
    throw new Error('mail intent order exhausted')
  }
  db.prepare(
    `INSERT INTO agent_session_mail_holds VALUES (?, ?, ?) ON CONFLICT(session_id) DO ${fresh ? 'NOTHING' : 'UPDATE SET intent_order=excluded.intent_order, state_json=excluded.state_json'}`
  ).run(sessionId, order, JSON.stringify(state))
}
export function mailHoldsCommitted(db: Database.Database, sessionId?: string): void {
  const cache = caches.get(db)
  const scope = sessionId && cache?.graph.get(sessionId)
  if (scope) {
    cache?.facts.delete(scope)
  } else {
    cache?.facts.clear()
  }
}
export function mailReleaseReceipt(sessionId: string): JournalOperationReceipt {
  let database: Database.Database | undefined
  return {
    write: (db) => {
      database = db
      writeMailHold(db, sessionId, { version: 1, status: 'released' })
    },
    committed: () => {
      if (database) {
        mailHoldsCommitted(database, sessionId)
      }
    }
  }
}
export function mailStopReceipt(
  sessionId: string,
  capture?: CaptureSessionMail
): JournalOperationReceipt {
  let database: Database.Database | undefined
  let finished: (() => void) | undefined
  return {
    write: (db) => {
      database = db
      let prior = { release: 0, members: new Set<string>(), ambiguous: true }
      let result: MailStopCapture = {}
      try {
        const records = readMailHoldRecords(db)
        const scope = mailLineageGraph(records).get(sessionId) ?? null
        prior = fold(db, scope?.aliases ?? null)
        result = capture?.(sessionId, records, scope) ?? {}
        finished = result.finished
      } catch {
        /* Capture failure cannot refuse personal Stop. */
      }
      writeMailHold(db, sessionId, {
        version: 1,
        status: 'held',
        members: [...new Set([...prior.members, ...(result.members ?? [])])],
        ambiguous: prior.ambiguous || !result.members,
        releasedThrough: prior.release
      })
    },
    committed: () => {
      if (database) {
        mailHoldsCommitted(database, sessionId)
      }
    },
    finished: () => finished?.()
  }
}
