import { type selectStructuredMailHandoff, structuredMailMaySubmit } from './mailbox-settlement'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import type { OrchestrationDb, MessageRow } from './db'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-delivery'

export function recordStructuredMailHandoff(
  db: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  update: (member: StructuredMailHandoff) => StructuredMailHandoff
): void {
  for (const message of messages) {
    const member = readMailHandoff(message.handoff)
    if (member?.kind === 'structured') {
      db.recordMailHandoff(mailbox, [message], update(member))
    }
  }
}

export function reconcileStructuredMailInput(
  host: StructuredMailboxPointerHost,
  db: OrchestrationDb,
  mailbox: string,
  messages: readonly MessageRow[],
  reference: StructuredMailHandoff
): boolean {
  try {
    const receipt = host.readReceipt?.(reference)
    if (receipt?.verdict === 'readable' && receipt.receipt.status === 'accepted') {
      const result = receipt.receipt.result
      recordStructuredMailHandoff(db, mailbox, messages, (member) => ({
        ...member,
        phase: 'offered',
        clientMessageId: result.kind === 'queued-draft' ? result.messageId : member.clientMessageId
      }))
      return false
    }
    return receipt?.verdict !== 'unreadable'
  } catch {
    return false
  }
}

export function currentSessionMail(
  input: {
    db: OrchestrationDb
    host: StructuredMailboxPointerHost
    resolveStructuredTarget: (address: string) => StructuredPointerTarget | null
  },
  choice: {
    address: string
    target: StructuredPointerTarget
    batch: NonNullable<ReturnType<typeof selectStructuredMailHandoff>>
  }
): boolean {
  const { messages, reference } = choice.batch
  const manifest = reference.manifest
  const next = input.resolveStructuredTarget(choice.address)
  return Boolean(
    manifest &&
    next?.sessionId === choice.target.sessionId &&
    next.dispatchId === choice.target.dispatchId &&
    input.host.takesMailNow?.(next.sessionId) !== false &&
    input.host.hasActionablePromptNow(next.sessionId) !== true &&
    input.host.currentFence(next.sessionId) === manifest.runtimeFence &&
    input.host.currentContextClearOperationId(next.sessionId) === manifest.context &&
    manifest.members.length === messages.length &&
    manifest.members.every((id, index) => messages[index]?.id === id) &&
    input.db.isMailHandoffCurrent(choice.address, messages, reference.authority) &&
    messages.every((message) => {
      const member = readMailHandoff(message.handoff)
      return (
        member?.kind === 'structured' &&
        structuredMailMaySubmit(member, input.host.readHandoffEvidenceNow, manifest.members)
      )
    })
  )
}
