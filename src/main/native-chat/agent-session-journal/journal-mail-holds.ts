import type Database from '../../sqlite/sync-database'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import type { JournalOperationReceipt } from './journal-row-writer'

export type MailHoldFacts = { members: ReadonlySet<string>; ambiguous: boolean; key: string }
export type MailStopCapture = { members?: readonly string[]; finished?: () => void }
export type CaptureSessionMail = (
  sessionId: string,
  records: readonly AgentSessionRecord[]
) => MailStopCapture
export type MailHoldState = { version: 1 } & (
  | { status: 'released' }
  | { status: 'held'; members: string[]; ambiguous: boolean; releasedThrough: number }
)
const revisions = new WeakMap<Database.Database, number>()
const caches = new WeakMap<Database.Database, Map<string, MailHoldFacts>>()

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
  const next = new Map(
    records.map((record) => [
      record.sessionId,
      record.conversationCommand?.command === 'clear' &&
      record.conversationCommand.phase === 'committed'
        ? record.conversationCommand.replacementSessionId
        : undefined
    ])
  )
  if (!next.has(sessionId)) {
    return null
  }
  const group = new Set([sessionId])
  for (let changed = true; changed;) {
    changed = false
    for (const [id, successor] of next) {
      if (successor && (group.has(id) || group.has(successor))) {
        if (!next.has(successor)) {
          return null
        }
        if (!group.has(id) || !group.has(successor)) {
          changed = true
        }
        group.add(id)
        group.add(successor)
      }
    }
  }
  for (const id of group) {
    const visited = new Set<string>()
    let at: string | undefined = id
    while (at) {
      if (visited.has(at)) {
        return null
      }
      visited.add(at)
      at = next.get(at)
    }
  }
  return [...group].sort()
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
export function readMailHoldFacts(
  db: Database.Database,
  sessionId: string,
  records: () => readonly AgentSessionRecord[],
  recordsRevision: number
): MailHoldFacts {
  const key = `${revisions.get(db) ?? 0}:${recordsRevision}`
  const cache = caches.get(db) ?? new Map<string, MailHoldFacts>()
  caches.set(db, cache)
  const prior = cache.get(sessionId)
  if (recordsRevision >= 0 && prior?.key === key) {
    return prior
  }
  let facts: MailHoldFacts
  try {
    facts = { ...fold(db, mailHoldAliases(sessionId, records())), key }
  } catch {
    facts = { members: new Set(), ambiguous: true, key }
  }
  cache.set(sessionId, facts)
  return facts
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
export function mailHoldsCommitted(db: Database.Database): void {
  revisions.set(db, (revisions.get(db) ?? 0) + 1)
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
        mailHoldsCommitted(database)
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
        prior = fold(db, mailHoldAliases(sessionId, records))
        result = capture?.(sessionId, records) ?? {}
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
        mailHoldsCommitted(database)
      }
    },
    finished: () => finished?.()
  }
}
