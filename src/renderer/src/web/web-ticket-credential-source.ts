import type { WebDeviceSigningKey } from './web-device-key'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

/**
 * Pairs this browser by redeeming a single-use ticket. After a lost reply it signs in with the
 * reserved id first (design §4.4): success means the host committed; a refusal means nothing was
 * written, so it redeems again (the host then says whether another device took the ticket).
 */
export function createWebTicketCredentialSource(args: {
  ticket: string
  deviceId: string
  key: WebDeviceSigningKey
  deviceLabel: string
  ephemeral: boolean
}): WebRuntimeCredentialSource {
  let step: 'redeem' | 'key-first' | 'confirmed' = 'redeem'
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
        step = 'key-first'
      }
    },
    keyAuthRefused: (errorCode) => {
      if (
        step !== 'key-first' ||
        (errorCode !== 'registry_unavailable' && errorCode !== 'device_revoked')
      ) {
        return false
      }
      step = 'redeem'
      return true
    },
    // Why: the key belongs to a pairing still being made; only the caller decides to drop it.
    deviceRevoked: async () => false,
    migrated: async () => {},
    migrationUnavailable: () => {}
  }
}
