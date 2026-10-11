import type { E2EETicketRedemption, MobileE2EEAuthFailureCode } from './mobile-e2ee-auth-validation'

// Why: covers the owner's two-minute approval window plus the durable registry write.
export const PAIRING_TICKET_REDEMPTION_TIMEOUT_MS = 2 * 60_000 + 15_000

export type E2EERedemptionOutcome<TDevice> =
  | { ok: true; device: TDevice }
  | { ok: false; code: MobileE2EEAuthFailureCode }

export type RedeemE2EETicket<TDevice> = (
  redemption: E2EETicketRedemption,
  context: { transcriptHashB64: string; signal: AbortSignal }
) => Promise<E2EERedemptionOutcome<TDevice>>

/** Never rejects: a thrown redemption is storage trouble, never a verdict on the device. */
export async function settleE2EERedemption<TDevice>(
  redeem: RedeemE2EETicket<TDevice>,
  redemption: E2EETicketRedemption,
  context: { transcriptHashB64: string; signal: AbortSignal }
): Promise<E2EERedemptionOutcome<TDevice>> {
  try {
    return await redeem(redemption, context)
  } catch (error) {
    console.error('[pairing] Ticket redemption failed:', error)
    return { ok: false, code: 'registry_unavailable' }
  }
}

/** Runs a redemption; `onSettled` never fires once the returned controller aborts (socket closed). */
export function startE2EERedemption<TDevice>(
  redeem: RedeemE2EETicket<TDevice>,
  redemption: E2EETicketRedemption,
  args: {
    transcriptHashB64: string
    onSettled: (outcome: E2EERedemptionOutcome<TDevice>) => void
  }
): AbortController {
  const abort = new AbortController()
  void settleE2EERedemption(redeem, redemption, {
    transcriptHashB64: args.transcriptHashB64,
    signal: abort.signal
  }).then((outcome) => {
    if (!abort.signal.aborted) {
      args.onSettled(outcome)
    }
  })
  return abort
}
