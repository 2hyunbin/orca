import { mailAdmissionPermission } from '../../native-chat/agent-session-journal/journal-mail-holds'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { readAgentJournalTurnOutcome } from '../../../shared/agent-session-turn-record'
import { classifyDispatchRejection } from '../../../shared/structured-agent-session-dispatch-rejection'
import { structuredRecoverySource, type StructuredMailHandoff } from './mail-handoff'
import type { StructuredMailEvidence } from './mailbox-settlement'

export function mailHandoffWasCut(
  reference: StructuredMailHandoff,
  evidence: StructuredMailEvidence
): boolean {
  const turn = evidence.owner?.turn
  const verdict =
    turn &&
    agentTurnVerdict({
      state: turn.state,
      outcome: readAgentJournalTurnOutcome(turn)
    })
  return Boolean(
    turn &&
    evidence.submission?.dispatchState !== 'rejected' &&
    evidence.epoch === reference.epoch &&
    !evidence.personStopped &&
    !evidence.stopInForce &&
    (verdict === 'failure' || verdict === 'interruption' || evidence.diedTurnId === turn.turnId)
  )
}

export function mailTransportWasRefused(evidence: StructuredMailEvidence): boolean {
  if (evidence.submission?.dispatchState !== 'rejected') {
    return false
  }
  const { category } = classifyDispatchRejection(evidence.submission)
  return category === 'undelivered' || category === 'startFailed' || category === 'transport'
}

export function structuredMailMaySubmit(
  reference: StructuredMailHandoff,
  read: (reference: StructuredMailHandoff) => StructuredMailEvidence | null,
  members: readonly string[] = reference.manifest?.members ?? []
): boolean {
  const destination = read(reference)
  const original = structuredRecoverySource(reference)
  const evidence = original ? read(original) : null
  return Boolean(
    destination &&
    destination.epoch === reference.epoch &&
    mailAdmissionPermission(destination.mailHold, members) &&
    (!original || (evidence && !destination.stopInForce && mailHandoffWasCut(original, evidence)))
  )
}
