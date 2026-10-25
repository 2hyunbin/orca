import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { MailStopCapture } from '../../native-chat/agent-session-journal/journal-mail-holds'
import type { OrchestrationDb } from './db'
import { sessionMailRecipient } from './session-mail-recipient'

/** Acquires only its own zero-wait reservation; the receipt releases it after journal COMMIT. */
export function captureSessionMailAtStop(
  db: OrchestrationDb | null,
  sessionId: string,
  records: readonly AgentSessionRecord[],
  retire: (db: OrchestrationDb) => void
): MailStopCapture {
  if (!db || db.db.isTransaction) {
    return {}
  }
  let acquired = false
  let timeout: number | undefined
  const finished = () => {
    let failed = false
    try {
      if (acquired) {
        db.db.exec('ROLLBACK')
        acquired = false
      }
    } catch {
      failed = true
    }
    try {
      if (timeout !== undefined) {
        db.db.pragma(`busy_timeout = ${timeout}`)
      }
    } catch {
      failed = true
    }
    if (failed) {
      try {
        retire(db)
      } catch (error) {
        console.warn('[mail] capture connection retirement failed', error)
      }
    }
  }
  try {
    timeout = Number(db.db.pragma('busy_timeout', { simple: true }))
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      return {}
    }
    db.db.pragma('busy_timeout = 0')
    db.db.exec('BEGIN IMMEDIATE')
    acquired = true
    const scope = sessionMailRecipient(db, sessionId, records)
    const members = db.db
      .prepare(
        `SELECT id, run_id, to_handle FROM messages WHERE read = 0 AND delivery_contract = 'current_delivery'`
      )
      .all()
      .filter((row) => {
        const address = String(row.to_handle)
        const runId = String(row.run_id)
        if (address.startsWith('run:')) {
          return scope.runs.has(address.slice(4))
        }
        if (address.startsWith('dispatch:')) {
          return scope.dispatches.has(address.slice(9))
        }
        const dispatch = db.findActiveDispatchForDirectMessageOwner(
          runId,
          address,
          scope.direct.has(address) ? scope.paneKey : undefined
        )
        if (dispatch) {
          return scope.dispatches.has(dispatch.id)
        }
        const routed = db.db
          .prepare('SELECT 1 FROM run_coordinator_handles WHERE run_id = ? AND terminal_handle = ?')
          .get(runId, address)
        if (routed) {
          return scope.runs.has(runId)
        }
        return scope.direct.has(address)
      })
      .map((row) => String(row.id))
    return { members, finished }
  } catch {
    finished()
    return {}
  }
}
