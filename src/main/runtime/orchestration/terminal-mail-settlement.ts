import type { TerminalMailTarget } from '../../agent-hooks/server/terminal-mail-target'
import type { OrchestrationDb } from './db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type MessageRow } from './db'
import { readMailHandoff, type TerminalMailHandoff } from './mail-handoff'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  hasUnfilteredOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

export function selectTerminalMailHandoff(input: {
  db: OrchestrationDb
  mailbox: string
  target: TerminalMailTarget | null
  wasAbandoned: (target: TerminalMailTarget) => boolean
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  reservedTypes: ReadonlySet<string> | undefined
}): MessageRow[] {
  if (hasUnfilteredOrchestrationWaiter(input.waiters)) {
    return []
  }
  const excluded = new Set(input.reservedTypes)
  for (const waiter of input.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excluded.add(type)
    }
  }
  const authority = input.db.mailboxHandoffAuthority(input.mailbox)
  const id = mintAgentSessionOperationId(Date.now())
  const messages: MessageRow[] = []
  let afterSequence = 0
  for (;;) {
    const candidates = input.db.getAutomaticMailCandidates(input.mailbox, {
      afterSequence,
      excludeTypes: [...excluded],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    for (const message of candidates) {
      afterSequence = message.sequence
      const prior = readMailHandoff(message.handoff)
      if (prior && (prior.kind !== 'terminal' || prior.authority !== authority)) {
        continue
      }
      const recovery = prior?.kind === 'terminal' && prior.phase === 'offered'
      if (
        recovery &&
        (!prior.target || message.recovery_used || !input.wasAbandoned(prior.target))
      ) {
        continue
      }
      if (
        prior?.kind === 'terminal' &&
        prior.recoverySource &&
        !input.wasAbandoned(prior.recoverySource)
      ) {
        continue
      }
      const reference: TerminalMailHandoff = {
        version: 1,
        kind: 'terminal',
        id: prior?.kind === 'terminal' && !recovery ? prior.id : id,
        authority,
        phase: 'reserved',
        target: input.target,
        ...(recovery && prior.target
          ? { recoverySource: prior.target }
          : prior?.kind === 'terminal' && prior.recoverySource
            ? { recoverySource: prior.recoverySource }
            : {})
      }
      const reserved = input.db.reserveMailHandoff(input.mailbox, message, reference, recovery)
      if (reserved) {
        messages.push(reserved)
      }
      if (messages.length === ORCHESTRATION_DELIVERY_BATCH_LIMIT) {
        return messages
      }
    }
    if (candidates.length < ORCHESTRATION_DELIVERY_BATCH_LIMIT) {
      return messages
    }
  }
}

export function terminalMailHandoffCanSubmit(
  db: OrchestrationDb | null,
  mailbox: string,
  messages: readonly { id: string; handoff?: string | null }[],
  wasAbandoned: (target: TerminalMailTarget) => boolean
): boolean {
  if (!db) {
    return false
  }
  return messages.every((message) => {
    const current = db.getMessageById(message.id)
    if (
      !current ||
      current.read ||
      current.to_handle !== mailbox ||
      (current.handoff ?? null) !== (message.handoff ?? null)
    ) {
      return false
    }
    const handoff = readMailHandoff(current.handoff)
    return (
      handoff === null ||
      (handoff.kind === 'terminal' &&
        handoff.authority === db.mailboxHandoffAuthority(mailbox) &&
        (!handoff.recoverySource || wasAbandoned(handoff.recoverySource)))
    )
  })
}
