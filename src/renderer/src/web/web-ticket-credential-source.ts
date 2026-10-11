import type { WebDeviceSigningKey } from './web-device-key'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

/**
 * Pairs this browser by redeeming a single-use ticket. After a lost reply it signs in with the
 * reserved id first (design §4.4): success means the host committed; a refusal means nothing was
 * written, so it redeems again. If that redemption then finds the ticket consumed, the consumer
 * may be this browser, so it confirms with the key before reporting another device.
 *
 * - redeem: send the ticket.
 * - key-first: a redemption's reply was lost; try the reserved id before redeeming again.
 * - confirming: the ticket reads as consumed after an earlier redemption was in doubt.
 * - confirmed: the host authenticated this key.
 */
export function createWebTicketCredentialSource(args: {
  ticket: string
  deviceId: string
  key: WebDeviceSigningKey
  deviceLabel: string
  ephemeral: boolean
}): WebRuntimeCredentialSource {
  let step: 'redeem' | 'key-first' | 'confirming' | 'confirmed' = 'redeem'
  let redemptionInDoubt = false
  const keyPlan: WebRuntimeAuthPlan = { kind: 'device-key', deviceId: args.deviceId, key: args.key }
  return {
    nextPlan: () =>
      step === 'redeem'
        ? {
            kind: 'redeem',
            ticket: args.ticket,
            deviceId: args.deviceId,
            key: args.key,
            deviceLabel: args.deviceLabel,
            ephemeral: args.ephemeral
          }
        : keyPlan,
    authenticated: () => {
      step = 'confirmed'
    },
    redemptionInterrupted: () => {
      if (step === 'redeem') {
        redemptionInDoubt = true
        step = 'key-first'
      }
    },
    resolveRejection: (plan, errorCode) => {
      if (plan.kind === 'redeem') {
        if (errorCode === 'ticket_consumed' && redemptionInDoubt) {
          step = 'confirming'
          return { kind: 'retry' }
        }
        return null
      }
      if (plan.kind !== 'device-key') {
        return null
      }
      if (errorCode === 'registry_unavailable') {
        // Why: storage trouble is no verdict; key-first still redeems next, confirming keeps trying.
        if (step === 'key-first') {
          step = 'redeem'
        }
        return step === 'confirmed' ? null : { kind: 'retry' }
      }
      if (errorCode === 'device_revoked' && step === 'key-first') {
        step = 'redeem'
        return { kind: 'retry' }
      }
      // Why cancelled, not "another device": a redemption of ours was in doubt, so the ticket
      // was most likely burned (denied, or its socket dropped mid-approval).
      if (errorCode === 'device_revoked' && step === 'confirming') {
        return { kind: 'failed', reason: 'ticket-cancelled' }
      }
      return null
    },
    // Why: the key belongs to a pairing still being made; only the caller decides to drop it.
    deviceRevoked: async () => false,
    migrated: async () => {},
    migrationUnavailable: () => {}
  }
}
