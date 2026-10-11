import type { PairedE2EEAuthReply } from '../../../shared/paired-e2ee-client-handshake'
import { INSECURE_WEB_ORIGIN_AUTH_CODE } from '../../../shared/web-origin-security'
import type { WebRuntimeAuthFailureReason } from './web-runtime-client-error'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

export type WebRuntimeAuthOutcome =
  | { kind: 'failed'; reason: WebRuntimeAuthFailureReason }
  // Storage trouble on the host: keep everything and reconnect with backoff.
  | { kind: 'retry' }

/**
 * Maps a sealed rejection to what the browser does. Only a device_revoked naming this
 * browser's own key deletes it; a downgraded host or bad proof keeps it for a later upgrade.
 */
export async function resolveWebRuntimeAuthRejection(
  plan: WebRuntimeAuthPlan | null,
  reply: Extract<PairedE2EEAuthReply, { kind: 'rejected' }>,
  source: WebRuntimeCredentialSource
): Promise<WebRuntimeAuthOutcome> {
  if (reply.errorCode === INSECURE_WEB_ORIGIN_AUTH_CODE) {
    return { kind: 'failed', reason: 'insecure-origin' }
  }
  if (plan?.kind === 'redeem') {
    return { kind: 'failed', reason: ticketRefusalReason(reply.errorCode) }
  }
  if (plan?.kind !== 'device-key') {
    return { kind: 'failed', reason: 'unauthorized' }
  }
  // Why first: a ticket's key-first retry must redeem again, never delete its pending key.
  if (source.keyAuthRefused?.(reply.errorCode)) {
    return { kind: 'retry' }
  }
  if (reply.errorCode === 'registry_unavailable') {
    return { kind: 'retry' }
  }
  if (reply.errorCode === 'bad_auth') {
    return { kind: 'failed', reason: 'device-downgraded' }
  }
  if (
    reply.errorCode === 'device_revoked' &&
    reply.errorDeviceId === plan.deviceId &&
    (await source.deviceRevoked(plan.deviceId))
  ) {
    return { kind: 'failed', reason: 'device-revoked' }
  }
  return { kind: 'failed', reason: 'unauthorized' }
}

function ticketRefusalReason(errorCode: string | null): WebRuntimeAuthFailureReason {
  switch (errorCode) {
    case 'approval_denied':
      return 'approval-denied'
    case 'ticket_consumed':
      return 'ticket-consumed'
    case 'device_key_in_use':
      return 'device-key-in-use'
    // Why: a host that predates tickets answers the redemption shape with bad_auth.
    case 'bad_auth':
      return 'ticket-unsupported'
    case null:
    default:
      return 'ticket-invalid'
  }
}
