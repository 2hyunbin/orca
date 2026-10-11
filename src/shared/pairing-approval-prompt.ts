import { z } from 'zod'

export const PAIRING_APPROVAL_REQUESTED_CHANNEL = 'pairing:approvalRequested'
export const PAIRING_APPROVAL_CANCELLED_CHANNEL = 'pairing:approvalCancelled'
export const PAIRING_APPROVAL_ANSWER_CHANNEL = 'pairing:answerApproval'
export const CREATE_LOCAL_PAIRING_TICKET_CHANNEL = 'pairing:createLocalTicket'

type PairingApprovalPromptBase = {
  requestId: string
  hostName: string
  scope: 'runtime' | 'mobile'
  grants: string[]
  deviceLabel: string
  deviceKeyFingerprint: string
  // Names of the devices approving would replace.
  replaces: string[]
}

/**
 * What the owner sees. A replacement never carries the code: the owner must type the one the new
 * device shows, so a dialog that merely mirrors a code cannot be clicked through.
 */
export type PairingApprovalPrompt = PairingApprovalPromptBase &
  ({ mode: 'compare'; comparisonCode: string } | { mode: 'type-to-confirm' })

export const PairingApprovalAnswerSchema = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(['allow', 'deny']),
    typedCode: z.string().max(32).optional()
  })
  .strict()
export type PairingApprovalAnswer = z.infer<typeof PairingApprovalAnswerSchema>

export type LocalPairingTicketResult =
  | { available: true; ticketId: string; code: string; link: string; expiresAt: number }
  | { available: false; guidance?: string }
