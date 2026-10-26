/** Resolve structured-owned mail to a session turn, covering Run, session, Dispatch and worker-handle addresses. */

import {
  ORCA_SESSION_ADDRESS_PREFIX,
  isOrcaSessionId,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { currentRunCoordinatorOrcaSessionId } from './db/runs/run-coordinator-orca-session'
import { selectStructuredMailHandoff } from './mailbox-settlement'
import { currentSessionMail } from './structured-mailbox-pointer-receipt'
import { drainLegacyMailHandoff } from './legacy-mail-handoff'
import { structuredMailBody } from './structured-mail-source'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import {
  addressableSessionParty,
  structuredSessionMailReach
} from './structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'
import type { DispatchContextRow, RunRow } from './types'
import { chatAssigneeSessionId } from './chat-assignee'

/** A handle-less coordinator uses its generation-current session id; structured workers resolve by handle. */
export function handleLessCoordinatorSessionId(
  run: Pick<
    RunRow,
    | 'coordinator_handle'
    | 'coordinator_orca_session_id'
    | 'coordinator_orca_session_id_generation'
    | 'consumer_generation'
  >
): OrcaSessionId | null {
  if (run.coordinator_handle !== null) {
    return null
  }
  return currentRunCoordinatorOrcaSessionId(run)
}

/** Resolve any lineage session to its live reachable target; null means unreachable here. */
export function structuredSessionMailTarget(
  sessionId: string,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): StructuredPointerTarget | null {
  const record = store?.getRecord(sessionId)
  const reach = store && record ? structuredSessionMailReach(store, record, db) : null
  return reach?.kind === 'reachable'
    ? { sessionId: reach.session.sessionId, dispatchId: null }
    : null
}

/** Chat Dispatch target under its budget; undefined preserves non-chat worker lookup. */
export function chatDispatchMailTarget(
  dispatch: Pick<DispatchContextRow, 'id' | 'assignee_handle'>,
  db: OrchestrationDb | null | undefined
): StructuredPointerTarget | null | undefined {
  const sessionId = chatAssigneeSessionId(dispatch.assignee_handle)
  if (!sessionId) {
    return undefined
  }
  const target = structuredSessionMailTarget(sessionId, db)
  return target ? { ...target, dispatchId: dispatch.id } : null
}

/** Resolve session addresses; undefined lets other address forms use their own resolver. */
export function structuredSessionAddressTarget(
  mailboxHandle: string,
  db: OrchestrationDb | null | undefined
): StructuredPointerTarget | null | undefined {
  if (!mailboxHandle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    return undefined
  }
  const sessionId = parseOrcaSessionAddress(mailboxHandle)
  return sessionId ? structuredSessionMailTarget(sessionId, db) : null
}

/** Re-derive Run, direct and active-Dispatch mail on each idle edge, including root mail for /clear successors. */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  const party = isOrcaSessionId(sessionId) ? addressableSessionParty(sessionId, db) : null
  if (!party) {
    return []
  }
  const mailboxes = db.runsBoundToCoordinator(party).map((run) => `run:${run.id}`)
  if (db.getUnreadDirectMessageTypes(party.address).length > 0) {
    mailboxes.push(party.address)
  }
  // Re-derive Dispatch mail through current party identity; a cleared or restarted session has no future idle edge.
  const dispatch = db.findActiveDispatchForAssignee(party.address, party.paneKey ?? undefined)
  if (dispatch) {
    mailboxes.push(`dispatch:${dispatch.id}`)
  }
  return mailboxes
}

/** Open an existing DB to redrive restart mail; no file means no mail and creates no DB. */
export function structuredSessionIdleEdgeMailboxes(
  sessionId: string,
  openDb: () => OrchestrationDb | null
): string[] {
  let db: OrchestrationDb | null
  try {
    db = openDb()
  } catch (error) {
    console.warn('[orchestration] skipped a structured session mail edge: no database', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
  return db ? structuredSessionOwnedMailboxes(sessionId, db) : []
}

class MailPreparation extends Error {
  constructor(readonly sources: { sessionId: string; clientMessageId: string }[]) {
    super('mail evidence preparation')
  }
}
const retiredPreparation = new Error('mail preparation retired')

export async function selectSessionMail(input: {
  db: OrchestrationDb
  mailbox: string
  target: StructuredPointerTarget
  reservedTypes: ReadonlySet<string> | undefined
  reconciled: ReadonlySet<string>
  host: StructuredMailboxPointerHost
  getMessageWaiters: (mailbox: string) => ReadonlySet<OrchestrationMessageWaiter> | undefined
  resolveStructuredTarget: (mailbox: string) => StructuredPointerTarget | null
  getCliCommand: () => OrchestrationCliCommand
  senderName: SenderNameResolver
  park: (address: string) => void
  ownWrite: <T>(write: () => T) => T
  current: () => boolean
  settle: (read: StructuredMailboxPointerHost['readHandoffEvidenceNow']) => ReadonlySet<string>
  settlementOnly: boolean
}) {
  const { db, mailbox, target, host } = input
  const prepared = new Map<string, boolean>()
  const missing = new Map<string, { sessionId: string; clientMessageId: string }>()
  const decision = <T>(run: () => T): T => {
    const result = run()
    if (missing.size) {
      throw new MailPreparation([...missing.values()])
    }
    return result
  }
  const read: StructuredMailboxPointerHost['readHandoffEvidenceNow'] = (source) => {
    if (!prepared.has(source.sessionId)) {
      missing.set(source.sessionId, source)
      return null
    }
    if (!prepared.get(source.sessionId)) {
      return null
    }
    const value = host.readHandoffEvidenceNow(source)
    if (!value) {
      throw retiredPreparation
    }
    return value
  }
  let sources = [{ sessionId: target.sessionId, clientMessageId: '' }]
  for (;;) {
    for (const source of sources) {
      const available = await host.readHandoffEvidence(source).catch(() => null)
      if (!input.current()) {
        return null
      }
      prepared.set(source.sessionId, Boolean(available))
    }
    missing.clear()
    try {
      return input.ownWrite(() =>
        db.claimMailHandoff(() =>
          decision(() => {
            if (!input.current()) {
              throw retiredPreparation
            }
            const skipped = new Set([...input.reconciled, ...input.settle(read)])
            if (
              input.settlementOnly ||
              host.takesMailNow?.(target.sessionId) === false ||
              host.hasActionablePromptNow(target.sessionId) === true
            ) {
              return null
            }
            const session = read({ sessionId: target.sessionId, clientMessageId: '' })
            const fence = host.currentFence(target.sessionId)
            if (!session || fence === null) {
              return null
            }
            let chosen: {
              address: string
              target: StructuredPointerTarget
              batch: NonNullable<ReturnType<typeof selectStructuredMailHandoff>>
            } | null = null
            for (const address of new Set([
              mailbox,
              ...structuredSessionOwnedMailboxes(target.sessionId, db)
            ])) {
              const addressTarget = input.resolveStructuredTarget(address)
              if (addressTarget?.sessionId !== target.sessionId) {
                continue
              }
              input.park(address)
              const legacy = db.getStructuredPointerOperation(address)
              if (legacy?.session_id === target.sessionId) {
                const evidence = read({
                  sessionId: target.sessionId,
                  clientMessageId: legacy.operation_id
                })
                if (evidence) {
                  drainLegacyMailHandoff(db, legacy, evidence)
                }
              }
              const batch = selectStructuredMailHandoff({
                db,
                mailbox: address,
                sessionId: target.sessionId,
                epoch: session.epoch,
                frontier: session.frontier,
                waiters: input.getMessageWaiters(address),
                reservedTypes: new Set([
                  ...(address === mailbox ? (input.reservedTypes ?? []) : []),
                  'heartbeat'
                ]),
                limit: 1,
                readEvidence: read,
                skipOperations: skipped,
                accept: (batch) =>
                  currentSessionMail(
                    { ...input, host: { ...host, readHandoffEvidenceNow: read } },
                    { address, target: addressTarget, batch }
                  ),
                manifest: (messages) => ({
                  members: messages.map((message) => message.id),
                  dispatchId: addressTarget.dispatchId,
                  runtimeFence: fence,
                  context: host.currentContextClearOperationId(target.sessionId),
                  body: JSON.stringify(
                    structuredMailBody({
                      db,
                      mailboxHandle: address,
                      dispatchId: addressTarget.dispatchId,
                      message: messages[0],
                      senderName: input.senderName,
                      cliCommand: input.getCliCommand()
                    })
                  )
                })
              })
              if (!batch) {
                continue
              }
              const candidate = { address, target: addressTarget, batch }
              if (!chosen || batch.messages[0].sequence < chosen.batch.messages[0].sequence) {
                chosen = candidate
              }
            }
            if (!input.current()) {
              throw retiredPreparation
            }
            return chosen
          })
        )
      )
    } catch (error) {
      if (!(error instanceof MailPreparation)) {
        if (error === retiredPreparation) {
          return null
        }
        throw error
      }
      sources = error.sources
    }
  }
}
