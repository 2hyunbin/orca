import type { MailLineageScope } from '../../native-chat/agent-session-journal/journal-mail-holds'
import { sessionMailRecipient } from './session-mail-recipient'
/**
 * Where a mailbox owned by a structured session is delivered: a chat that coordinates a Run
 * (`run:<id>` with no coordinator handle), a session addressed directly at `orca_session_id:<id>`, and the
 * live session behind a structured worker's handle. The session is resolved here, never a pane, and
 * takes the pointer as a session turn.
 */

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

/**
 * The session a Run's coordinator binding names when that binding has no handle. A structured
 * worker coordinates by its own handle and resolves through it, so only a handle-less binding names
 * a session here, and only by an Orca session id that still counts (see
 * `currentRunCoordinatorOrcaSessionId`).
 */
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

/**
 * The structured-lane target for `sessionId`'s conversation: its live session, whichever session of
 * the lineage was named; null when mail cannot reach it here.
 */
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

/**
 * The target of a `dispatch:<id>` mailbox whose assignee is a chat: its live session, under the
 * Dispatch's budget. `undefined` when the assignee is not a chat, so a worker keeps its own lookup.
 */
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

/**
 * The target of an `orca_session_id:<id>` mailbox; `undefined` when the handle is not a session address at
 * all, so other address forms keep their own resolution.
 */
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

/**
 * Every mailbox a session reads for itself: the Runs it coordinates, its own direct mail and its
 * active Dispatch, a worker's or a chat's; a `/clear` successor reads its root's. Re-derived from the database
 * on each idle edge rather than remembered, so mail that arrived while the session could not take
 * it (mid-turn, closed) is found again.
 */
export function structuredSessionOwnedMailboxes(sessionId: string, db: OrchestrationDb): string[] {
  const party = isOrcaSessionId(sessionId) ? addressableSessionParty(sessionId, db) : null
  if (!party) {
    return []
  }
  const mailboxes = db.runsBoundToCoordinator(party).map((run) => `run:${run.id}`)
  if (db.getUnreadDirectMessageTypes(party.address).length > 0) {
    mailboxes.push(party.address)
  }
  // Why: Dispatch mail parked on a session a /clear or restart ended waits for an edge that never
  // comes. A party's address is what its Dispatch names it by: a worker's handle, a chat's root.
  const dispatch = db.findActiveDispatchForAssignee(party.address, party.paneKey ?? undefined)
  if (dispatch) {
    mailboxes.push(`dispatch:${dispatch.id}`)
  }
  return mailboxes
}

export function structuredSessionDebtAddresses(
  sessionId: string,
  db: OrchestrationDb,
  scope?: MailLineageScope
): string[] {
  const aliases = scope?.aliases ?? [sessionId]
  const addresses = new Set(
    aliases.filter(isOrcaSessionId).map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  )
  try {
    const recipient = sessionMailRecipient(
      db,
      sessionId,
      [],
      scope ?? { aliases: [sessionId], root: sessionId }
    )
    for (const address of recipient.direct) {
      addresses.add(address)
    }
    for (const run of recipient.runs) {
      addresses.add(`run:${run}`)
    }
  } catch {
    /* Exact recorded-session debt is independent of lineage permission. */
  }
  for (const alias of aliases.filter(isOrcaSessionId)) {
    for (const run of db.runsBoundToCoordinator({
      orcaSessionId: alias,
      terminalHandle: null,
      paneKey: null
    })) {
      addresses.add(`run:${run.id}`)
    }
  }
  const directAddresses = [...addresses]
  for (const address of directAddresses) {
    for (const row of db.db
      .prepare('SELECT id FROM dispatch_contexts WHERE assignee_handle = ?')
      .all(address)) {
      addresses.add(`dispatch:${String(row.id)}`)
    }
  }
  return [...addresses]
}

/** The mailboxes a session's idle edge re-derives, opening an existing database if nothing has
 *  yet: after a restart this edge is what redrives mail stored before it. No database file means
 *  no mail, so `openDb` answers null and nothing is created. */
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
  constructor(readonly source: { sessionId: string; clientMessageId: string }) {
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
  const read: StructuredMailboxPointerHost['readHandoffEvidenceNow'] = (source) => {
    if (!prepared.has(source.sessionId)) {
      throw new MailPreparation(source)
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
  let source = { sessionId: target.sessionId, clientMessageId: '' }
  for (;;) {
    const available = await host.readHandoffEvidence(source).catch(() => null)
    if (!input.current()) {
      return null
    }
    prepared.set(source.sessionId, Boolean(available))
    try {
      return input.ownWrite(() =>
        db.claimMailHandoff(() => {
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
            for (;;) {
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
                break
              }
              const candidate = { address, target: addressTarget, batch }
              if (!currentSessionMail(input, candidate)) {
                skipped.add(batch.reference.operationId)
                continue
              }
              if (!chosen || batch.messages[0].sequence < chosen.batch.messages[0].sequence) {
                chosen = candidate
              }
              break
            }
          }
          if (!input.current()) {
            throw retiredPreparation
          }
          return chosen
        })
      )
    } catch (error) {
      if (!(error instanceof MailPreparation)) {
        if (error === retiredPreparation) {
          return null
        }
        throw error
      }
      source = error.source
    }
  }
}
