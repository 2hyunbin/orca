import { randomUUID } from 'node:crypto'
import {
  PAIRING_APPROVAL_CANCELLED_CHANNEL,
  PAIRING_APPROVAL_REQUESTED_CHANNEL,
  type PairingApprovalAnswer,
  type PairingApprovalPrompt
} from '../../shared/pairing-approval-prompt'
import type {
  PairingTicketApproval,
  PairingTicketApprovalRequest,
  PairingTicketApprover
} from './pairing-ticket-redemption'

type PairingApprovalChannel =
  | typeof PAIRING_APPROVAL_REQUESTED_CHANNEL
  | typeof PAIRING_APPROVAL_CANCELLED_CHANNEL

/** Relays the host's approval question to the desktop window and its answer back. */
export class PairingApprovalBroker {
  private readonly pending = new Map<string, (approval: PairingTicketApproval) => void>()

  constructor(
    private readonly deps: {
      // false: no window could show it, so the pairing is denied.
      send: (channel: PairingApprovalChannel, payload: unknown) => boolean
      hostName: () => string
    }
  ) {}

  readonly approver: PairingTicketApprover = (request) =>
    new Promise<PairingTicketApproval>((resolve) => {
      const requestId = randomUUID()
      const settle = (approval: PairingTicketApproval): void => {
        if (!this.pending.delete(requestId)) {
          return
        }
        request.signal.removeEventListener('abort', onAbort)
        resolve(approval)
      }
      const onAbort = (): void => {
        if (this.pending.has(requestId)) {
          settle({ decision: 'deny' })
          this.deps.send(PAIRING_APPROVAL_CANCELLED_CHANNEL, { requestId })
        }
      }
      this.pending.set(requestId, settle)
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) {
        onAbort()
        return
      }
      const prompt = toPrompt(requestId, request, this.deps.hostName())
      if (!this.deps.send(PAIRING_APPROVAL_REQUESTED_CHANNEL, prompt)) {
        settle({ decision: 'deny' })
      }
    })

  /** False when the request already settled (answered, timed out or its socket closed). */
  answer(answer: PairingApprovalAnswer): boolean {
    const settle = this.pending.get(answer.requestId)
    if (!settle) {
      return false
    }
    settle(
      answer.decision === 'allow'
        ? {
            decision: 'allow',
            ...(answer.typedCode !== undefined ? { typedCode: answer.typedCode } : {})
          }
        : { decision: 'deny' }
    )
    return true
  }
}

function toPrompt(
  requestId: string,
  request: PairingTicketApprovalRequest,
  hostName: string
): PairingApprovalPrompt {
  const base = {
    requestId,
    hostName,
    scope: request.scope,
    grants: [...request.grants],
    deviceLabel: request.deviceLabel,
    deviceKeyFingerprint: request.deviceKeyFingerprint,
    replaces: request.replaces.map((device) => device.name)
  }
  // Why: on a replacement the owner must type the code the device shows, so the window never gets it.
  return request.replaces.length > 0
    ? { ...base, mode: 'type-to-confirm' }
    : { ...base, mode: 'compare', comparisonCode: request.comparisonCode }
}
