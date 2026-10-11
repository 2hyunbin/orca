import { createHash } from 'node:crypto'
import { sanitizeDeviceLabel, verifyDeviceProof } from '../../shared/device-key-proof'
import { normalizeTypedComparisonCode } from '../../shared/pairing-comparison-code'
import { DeviceKeyForkError } from './device-key-fork'
import type { DeviceEntry, DeviceRegistry } from './device-registry'
import { derivePairingComparisonCode } from './pairing-comparison-code-node'
import type { PairingTicketBook } from './pairing-ticket-book'
import type {
  E2EETicketRedemption,
  MobileE2EEAuthFailureCode
} from './rpc/mobile-e2ee-auth-validation'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

export const PAIRING_TICKET_APPROVAL_TIMEOUT_MS = 2 * 60_000
const FALLBACK_DEVICE_LABEL = 'Paired device'

export type PairingTicketApprovalRequest = {
  ticketId: string
  scope: 'runtime' | 'mobile'
  grants: readonly RuntimeDeviceGrant[]
  deviceLabel: string
  deviceKeyFingerprint: string
  comparisonCode: string
  // Non-empty: the owner must type the code, because approving replaces these devices.
  replaces: readonly { deviceId: string; name: string }[]
  signal: AbortSignal
}

export type PairingTicketApproval = { decision: 'allow'; typedCode?: string } | { decision: 'deny' }

export type PairingTicketApprover = (
  request: PairingTicketApprovalRequest
) => Promise<PairingTicketApproval>

export type PairingTicketRedemptionResult =
  | { ok: true; device: DeviceEntry; replacedDeviceIds: string[] }
  | { ok: false; code: MobileE2EEAuthFailureCode }

/** Short, non-secret fingerprint the owner can read aloud: sha256 of the device's public key. */
export function deviceKeyFingerprint(devicePublicKeyB64: string): string {
  const hex = createHash('sha256')
    .update(Buffer.from(devicePublicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 16)
  return hex.match(/.{4}/g)!.join(' ')
}

/**
 * Turns a ticket into exactly one keyed device row. The proof binds the new key to this
 * connection's transcript; the ticket is locked synchronously before any await (I1), and the row is
 * durably written before the caller replies.
 */
export async function redeemPairingTicket(args: {
  tickets: PairingTicketBook
  registry: DeviceRegistry
  approver: PairingTicketApprover | null
  redemption: E2EETicketRedemption
  transcriptHashB64: string
  signal: AbortSignal
  approvalTimeoutMs?: number
}): Promise<PairingTicketRedemptionResult> {
  const { redemption, tickets } = args
  const proofValid = verifyDeviceProof({
    devicePublicKeyB64: redemption.devicePublicKeyB64,
    deviceProofB64: redemption.deviceProofB64,
    purpose: 'redeem',
    transcriptHashB64: args.transcriptHashB64
  })
  if (!proofValid) {
    tickets.recordFailedProof(redemption.ticket)
    return { ok: false, code: 'bad_proof' }
  }
  const lock = tickets.beginRedemption(redemption.ticket)
  if (lock.kind === 'invalid') {
    return { ok: false, code: 'ticket_invalid' }
  }
  if (lock.kind === 'consumed') {
    return { ok: false, code: 'ticket_consumed' }
  }
  const { ticket } = lock
  // Why: the offer names the reserved id, so a mismatch is a forged or mixed-up redemption.
  if (redemption.deviceId !== ticket.reservedDeviceId) {
    lock.release()
    tickets.recordFailedProof(redemption.ticket)
    return { ok: false, code: 'ticket_invalid' }
  }
  const devices = args.registry.listDevices()
  if (devices.some((device) => device.devicePublicKeyB64 === redemption.devicePublicKeyB64)) {
    lock.burn()
    return { ok: false, code: 'device_key_in_use' }
  }
  const label = sanitizeDeviceLabel(redemption.deviceLabel, FALLBACK_DEVICE_LABEL)
  // Why: a same-named device is what an impersonator would mimic, so approval means replacement.
  const replaces = ticket.requiresApproval
    ? devices
        .filter((device) => device.scope === ticket.scope && device.name === label)
        .map((device) => ({ deviceId: device.deviceId, name: device.name }))
    : []
  if (ticket.requiresApproval) {
    const comparisonCode = derivePairingComparisonCode(
      Buffer.from(args.transcriptHashB64, 'base64')
    )
    const approval = await requestApproval(args.approver, {
      ticketId: ticket.ticketId,
      scope: ticket.scope,
      grants: ticket.grants,
      deviceLabel: label,
      deviceKeyFingerprint: deviceKeyFingerprint(redemption.devicePublicKeyB64),
      comparisonCode,
      replaces,
      signal: args.signal,
      timeoutMs: args.approvalTimeoutMs ?? PAIRING_TICKET_APPROVAL_TIMEOUT_MS
    })
    const typedCodeMatches =
      replaces.length === 0 ||
      (approval.decision === 'allow' &&
        normalizeTypedComparisonCode(approval.typedCode ?? '') === comparisonCode)
    // Why: a closed socket can no longer receive the reply, so its ticket must not stay live.
    if (approval.decision !== 'allow' || !typedCodeMatches || args.signal.aborted) {
      lock.burn()
      return { ok: false, code: 'approval_denied' }
    }
  }
  let device: DeviceEntry
  try {
    device = args.registry.addRedeemedDeviceKey({
      deviceId: ticket.reservedDeviceId,
      label,
      scope: ticket.scope,
      grants: [...ticket.grants],
      pairingReach: ticket.reach,
      devicePublicKeyB64: redemption.devicePublicKeyB64
    })
  } catch (error) {
    if (error instanceof DeviceKeyForkError) {
      lock.burn()
      return { ok: false, code: 'device_key_in_use' }
    }
    // Why: nothing was written, so the same client may retry this ticket.
    lock.release()
    console.error('[pairing] Failed to persist a redeemed device:', error)
    return { ok: false, code: 'registry_unavailable' }
  }
  lock.commit()
  return { ok: true, device, replacedDeviceIds: replaces.map((entry) => entry.deviceId) }
}

async function requestApproval(
  approver: PairingTicketApprover | null,
  request: Omit<PairingTicketApprovalRequest, 'signal'> & { signal: AbortSignal; timeoutMs: number }
): Promise<PairingTicketApproval> {
  if (!approver || request.signal.aborted) {
    return { decision: 'deny' }
  }
  const { timeoutMs, signal, ...details } = request
  const ended = new AbortController()
  const onAbort = (): void => ended.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ended.abort(), timeoutMs)
  try {
    return await Promise.race([
      approver({ ...details, signal: ended.signal }),
      new Promise<PairingTicketApproval>((resolve) =>
        ended.signal.addEventListener('abort', () => resolve({ decision: 'deny' }), {
          once: true
        })
      )
    ])
  } catch (error) {
    console.error('[pairing] Approval prompt failed:', error)
    return { decision: 'deny' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    // Why: tells a still-open dialog to close once the answer no longer matters.
    ended.abort()
  }
}
