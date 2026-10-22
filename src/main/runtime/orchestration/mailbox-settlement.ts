import type { OrchestrationMailNotice } from '../../../shared/agent-session-message-source'
import type {
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import { readAgentJournalTurnOutcome } from '../../../shared/agent-session-turn-record'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { OrchestrationDb, MessageRow } from './db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  hasUnfilteredOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

export type StructuredMailEvidence = {
  legacyNotice?: OrchestrationMailNotice | null
  epoch: string
  frontier: string
  stopInForce: boolean
  submission: AgentJournalSubmission | undefined
  owner: { itemId: string; turn: AgentJournalTurnLifecycle } | null
  latestTurn: AgentJournalTurnLifecycle | null
  acceptedUnopened: boolean
  personStopped: boolean
  diedTurnId: string | null
}

export function mailHandoffWasCut(
  reference: StructuredMailHandoff,
  evidence: StructuredMailEvidence
): boolean {
  const turn = evidence.owner?.turn
  if (
    !turn ||
    evidence.epoch !== reference.epoch ||
    evidence.personStopped ||
    evidence.stopInForce
  ) {
    return false
  }
  const verdict = agentTurnVerdict({
    state: turn.state,
    outcome: readAgentJournalTurnOutcome(turn)
  })
  return verdict === 'failure' || verdict === 'interruption' || evidence.diedTurnId === turn.turnId
}

export function mailTransportWasRefused(evidence: StructuredMailEvidence): boolean {
  if (evidence.submission?.dispatchState !== 'rejected') {
    return false
  }
  const { category } = classifyDispatchRejection(evidence.submission)
  return category === 'undelivered' || category === 'startFailed' || category === 'transport'
}

type SelectedHandoff = { message: MessageRow; reference: StructuredMailHandoff; recovery: boolean }

export async function selectStructuredMailHandoff(input: {
  db: OrchestrationDb
  mailbox: string
  sessionId: string
  epoch: string
  frontier: string
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  reservedTypes: ReadonlySet<string> | undefined
  readEvidence: (reference: StructuredMailHandoff) => Promise<StructuredMailEvidence | null>
}): Promise<{ messages: MessageRow[]; reference: StructuredMailHandoff } | null> {
  if (hasUnfilteredOrchestrationWaiter(input.waiters)) {
    return null
  }
  const excluded = new Set(input.reservedTypes)
  for (const waiter of input.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excluded.add(type)
    }
  }
  const authority = input.db.mailboxHandoffAuthority(input.mailbox)
  const operationId = mintAgentSessionOperationId(Date.now())
  const fresh: StructuredMailHandoff = {
    version: 1,
    kind: 'structured',
    sessionId: input.sessionId,
    epoch: input.epoch,
    frontier: input.frontier,
    operationId,
    authorizationId: operationId,
    clientMessageId: operationId,
    phase: 'reserved',
    authority
  }
  const eligible: SelectedHandoff[] = []
  const resumable: SelectedHandoff[] = []
  const evidenceByReference = new Map<string, StructuredMailEvidence | null>()
  let afterSequence = 0
  for (;;) {
    const candidates = input.db.getAutomaticMailCandidates(input.mailbox, {
      afterSequence,
      excludeTypes: [...excluded],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    if (!candidates.length) {
      break
    }
    for (let message of candidates) {
      afterSequence = message.sequence
      const prior = readMailHandoff(message.handoff)
      if (prior === null) {
        eligible.push({ message, reference: fresh, recovery: false })
        continue
      }
      if (
        prior.kind !== 'structured' ||
        prior.sessionId !== input.sessionId ||
        prior.authority !== authority
      ) {
        continue
      }
      const key = message.handoff ?? ''
      let evidence = evidenceByReference.get(key)
      if (evidence === undefined) {
        evidence = await input.readEvidence(prior).catch(() => null)
        evidenceByReference.set(key, evidence)
      }
      if (!evidence) {
        continue
      }
      if (prior.phase === 'reserved') {
        const refused = prior.nonAdmission !== undefined || mailTransportWasRefused(evidence)
        if (refused) {
          if (
            !evidence.stopInForce &&
            (prior.nonAdmission === 'expired' || prior.frontier !== evidence.frontier)
          ) {
            const { nonAdmission: _refusal, ...authorization } = prior
            // A terminal rejection proves this transport key cannot have consumed the authorization.
            resumable.push({
              message,
              recovery: false,
              reference: {
                ...authorization,
                epoch: input.epoch,
                frontier: evidence.frontier,
                operationId,
                clientMessageId: operationId
              }
            })
          } else if (
            !evidence.submission &&
            prior.nonAdmission === 'refused' &&
            Date.now() - Number(prior.operationId.slice(0, 13)) >
              AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
          ) {
            // Ask the host about this same key; elapsed time alone never authorizes a new key.
            resumable.push({ message, reference: prior, recovery: false })
          }
          continue
        }
        if (evidence.epoch !== prior.epoch) {
          continue
        }
        if (!evidence.submission) {
          resumable.push({ message, reference: prior, recovery: false })
          continue
        }
        if (evidence.submission.dispatchState !== 'accepted') {
          continue
        }
        const offered = {
          ...prior,
          phase: 'offered' as const,
          clientMessageId: evidence.submission.clientMessageId
        }
        input.db.recordMailHandoff(input.mailbox, [message], offered)
        const current = input.db.getMessageById(message.id)
        if (!current || current.handoff !== JSON.stringify(offered)) {
          continue
        }
        message = current
      }
      if (!message.recovery_used && mailHandoffWasCut(prior, evidence)) {
        eligible.push({
          message,
          reference: { ...fresh, recoverySource: prior.clientMessageId },
          recovery: true
        })
      }
    }
    if (
      eligible.length >= ORCHESTRATION_DELIVERY_BATCH_LIMIT ||
      candidates.length < ORCHESTRATION_DELIVERY_BATCH_LIMIT
    ) {
      break
    }
  }
  // Fresh mail never waits behind an unresolved older transport attempt.
  const selected = eligible.length ? eligible : resumable
  const reference = selected[0]?.reference
  if (!reference) {
    return null
  }
  const messages = selected
    .filter((entry) => entry.reference.operationId === reference.operationId)
    .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    .flatMap(({ message, reference: member, recovery }) => {
      if (message.handoff === JSON.stringify(member)) {
        return input.db.isMailHandoffCurrent(input.mailbox, [message], authority) ? [message] : []
      }
      const reserved = input.db.reserveMailHandoff(input.mailbox, message, member, recovery)
      return reserved ? [reserved] : []
    })
  return messages.length ? { messages, reference } : null
}
