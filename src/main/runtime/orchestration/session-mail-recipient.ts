import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import { mailHoldAliases } from '../../native-chat/agent-session-journal/journal-mail-holds'
import {
  structuredWorkerIdentityFromRow,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import type { OrchestrationDb } from './db'

/** Durable recipient scope, independent of provider, visibility, waiter or delivery eligibility. */
export function sessionMailRecipient(
  db: OrchestrationDb,
  sessionId: string,
  records: readonly AgentSessionRecord[]
) {
  const aliases = mailHoldAliases(sessionId, records)
  if (!aliases) {
    throw new Error('unproven mail lineage')
  }
  const roots = aliases.filter(
    (id) =>
      !records.some(
        (record) =>
          record.conversationCommand?.command === 'clear' &&
          record.conversationCommand.phase === 'committed' &&
          record.conversationCommand.replacementSessionId === id
      )
  )
  const root = roots[0]
  if (roots.length !== 1 || !root || !isOrcaSessionId(root)) {
    throw new Error('unproven mail root')
  }
  const resource = db.getWorkerTerminalResourceByProcessIncarnation(
    structuredWorkerProcessIncarnation(root)
  )
  const worker = resource && structuredWorkerIdentityFromRow(resource)
  if (
    (resource && !worker) ||
    (!worker &&
      db.db
        .prepare(
          'SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id = ? AND process_incarnation = ?'
        )
        .get(root, structuredWorkerProcessIncarnation(root)))
  ) {
    throw new Error('unproven worker identity')
  }
  const party = {
    orcaSessionId: root,
    terminalHandle: worker?.handle ?? null,
    paneKey: worker?.paneKey ?? null
  }
  const direct = new Set(aliases.filter(isOrcaSessionId).map(formatOrcaSessionAddress))
  if (worker) {
    direct.add(worker.handle)
  }
  const runs = new Set(db.runsBoundToCoordinator(party).map((run) => run.id))
  const dispatches = new Set(
    db
      .getActiveDispatchMailboxOwners(
        worker?.handle ?? formatOrcaSessionAddress(root),
        worker?.paneKey
      )
      .map((dispatch) => dispatch.id)
  )
  return { direct, runs, dispatches, paneKey: worker?.paneKey }
}
