import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import { publicKeyFromBase64 } from './e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'
import {
  isDeviceProofB64,
  isDevicePublicKeyB64,
  verifyDeviceProof
} from '../../../shared/device-key-proof'
import { INSECURE_WEB_ORIGIN_AUTH_CODE } from '../../../shared/web-origin-security'

export type ClassifiedE2EEAuth =
  | { kind: 'token'; deviceToken: string; clientCapabilities?: unknown }
  | { kind: 'device-key'; deviceId: string; deviceProofB64: string; clientCapabilities?: unknown }
  | E2EETicketRedemption
  | { kind: 'invalid' }

export type E2EETicketRedemption = {
  kind: 'redemption'
  ticket: string
  deviceId: string
  devicePublicKeyB64: string
  deviceProofB64: string
  deviceLabel: string
  // Session-only browsers: the host drops the row on restart or after idle.
  ephemeral: boolean
  clientCapabilities?: unknown
}

const V2_TOKEN_KEYS = 'deviceToken,transcriptHashB64,type,v'
const V2_DEVICE_KEY_KEYS = new Set(['clientCapabilities', 'deviceId', 'deviceProofB64'])
const V2_REDEMPTION_KEYS = new Set([
  'clientCapabilities',
  'deviceId',
  'deviceLabel',
  'devicePublicKeyB64',
  'deviceProofB64',
  'ephemeral',
  'ticket'
])
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The one parser for e2ee_auth: every accepted shape, nothing mixed. */
export function classifyE2EEAuth(
  plaintext: string,
  v2Session: DesktopMobileE2EEV2Session | null
): ClassifiedE2EEAuth {
  let auth: Record<string, unknown>
  try {
    const parsed: unknown = parseRemoteRuntimeJsonText(plaintext)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'invalid' }
    }
    auth = { ...parsed }
  } catch {
    return { kind: 'invalid' }
  }
  if (auth.type !== 'e2ee_auth') {
    return { kind: 'invalid' }
  }
  if (!v2Session) {
    // Why: legacy framing keeps today's token shape; key auth exists only inside a v2 transcript.
    return typeof auth.deviceToken === 'string' &&
      auth.deviceToken &&
      auth.v === undefined &&
      auth.transcriptHashB64 === undefined &&
      auth.deviceId === undefined &&
      auth.deviceProofB64 === undefined
      ? {
          kind: 'token',
          deviceToken: auth.deviceToken,
          clientCapabilities: auth.clientCapabilities
        }
      : { kind: 'invalid' }
  }
  if (auth.v !== 2 || auth.transcriptHashB64 !== v2Session.transcriptHashB64) {
    return { kind: 'invalid' }
  }
  const keys = Object.keys(auth).sort()
  // Why: mobile v2 token auth stays exact-key; capabilities ride only on key auth.
  if (
    keys.join(',') === V2_TOKEN_KEYS &&
    typeof auth.deviceToken === 'string' &&
    auth.deviceToken
  ) {
    return { kind: 'token', deviceToken: auth.deviceToken }
  }
  const rest = keys.filter((key) => key !== 'type' && key !== 'v' && key !== 'transcriptHashB64')
  if (auth.ticket !== undefined) {
    return classifyRedemption(auth, rest)
  }
  if (
    rest.every((key) => V2_DEVICE_KEY_KEYS.has(key)) &&
    typeof auth.deviceId === 'string' &&
    auth.deviceId.length > 0 &&
    auth.deviceId.length <= 128 &&
    isDeviceProofB64(auth.deviceProofB64)
  ) {
    return {
      kind: 'device-key',
      deviceId: auth.deviceId,
      deviceProofB64: auth.deviceProofB64,
      clientCapabilities: auth.clientCapabilities
    }
  }
  return { kind: 'invalid' }
}

function classifyRedemption(
  auth: Record<string, unknown>,
  keys: readonly string[]
): E2EETicketRedemption | { kind: 'invalid' } {
  const { ticket, deviceId, devicePublicKeyB64, deviceProofB64, deviceLabel } = auth
  return keys.every((key) => V2_REDEMPTION_KEYS.has(key)) &&
    typeof ticket === 'string' &&
    TICKET_PATTERN.test(ticket) &&
    typeof deviceId === 'string' &&
    deviceId.length > 0 &&
    deviceId.length <= 128 &&
    isDevicePublicKeyB64(devicePublicKeyB64) &&
    isDeviceProofB64(deviceProofB64) &&
    typeof deviceLabel === 'string' &&
    deviceLabel.length <= 256 &&
    (auth.ephemeral === undefined || auth.ephemeral === true)
    ? {
        kind: 'redemption',
        ticket,
        deviceId,
        devicePublicKeyB64,
        deviceProofB64,
        deviceLabel,
        ephemeral: auth.ephemeral === true,
        clientCapabilities: auth.clientCapabilities
      }
    : { kind: 'invalid' }
}

export type MobileE2EEAuthFailureCode =
  | 'bad_auth'
  | 'unauthorized'
  | 'device_revoked'
  | 'registry_unavailable'
  | 'bad_proof'
  | typeof INSECURE_WEB_ORIGIN_AUTH_CODE
  | PairingTicketFailureCode

// Why sealed: only a client holding this connection's keys learns why its ticket was refused.
export type PairingTicketFailureCode =
  | 'ticket_invalid'
  | 'ticket_consumed'
  | 'approval_denied'
  | 'device_key_in_use'

// The token matched, but this transport may not claim it (e.g. a first pairing from an insecure page).
export type DeviceTokenRefusal = { refused: typeof INSECURE_WEB_ORIGIN_AUTH_CODE }

export type DeviceKeyResolution<TDevice> =
  | { kind: 'found'; device: TDevice; devicePublicKeyB64: string }
  | { kind: 'unknown' }
  | { kind: 'not-keyed' }
  // The device exists but may not authenticate on this transport (e.g. another Relay binding).
  | { kind: 'refused' }
  | { kind: 'unavailable' }

export function authenticateMobileE2EE<TDevice extends { deviceToken?: string }>(args: {
  plaintext: string
  v2Session: DesktopMobileE2EEV2Session | null
  resolveDevice: (token: string) => TDevice | DeviceTokenRefusal | null
  // Absent on a host that does not accept device keys: key auth is then bad_auth, as before.
  resolveDeviceKey?: (deviceId: string) => DeviceKeyResolution<TDevice>
  acceptsRedemption?: boolean
}):
  | { ok: true; device: TDevice; clientCapabilities: unknown }
  | { ok: 'redeem'; redemption: E2EETicketRedemption }
  | { ok: false; code: MobileE2EEAuthFailureCode; deviceId?: string } {
  const auth = classifyE2EEAuth(args.plaintext, args.v2Session)
  if (auth.kind === 'token') {
    const device = args.resolveDevice(auth.deviceToken)
    if (device && 'refused' in device) {
      return { ok: false, code: device.refused }
    }
    // Why: a keyed row has no token, so presenting one can never match it.
    return device?.deviceToken === auth.deviceToken
      ? { ok: true, device, clientCapabilities: auth.clientCapabilities }
      : { ok: false, code: 'unauthorized' }
  }
  if (auth.kind === 'redemption') {
    // Why: redemption needs the owner's approval, so it settles asynchronously in the channel.
    return args.acceptsRedemption && args.v2Session
      ? { ok: 'redeem', redemption: auth }
      : { ok: false, code: 'bad_auth' }
  }
  if (auth.kind === 'invalid' || !args.resolveDeviceKey || !args.v2Session) {
    return { ok: false, code: 'bad_auth' }
  }
  const resolution = args.resolveDeviceKey(auth.deviceId)
  if (resolution.kind === 'unavailable') {
    return { ok: false, code: 'registry_unavailable' }
  }
  if (resolution.kind === 'unknown') {
    return { ok: false, code: 'device_revoked', deviceId: auth.deviceId }
  }
  if (resolution.kind === 'not-keyed') {
    return { ok: false, code: 'bad_auth' }
  }
  if (resolution.kind === 'refused') {
    return { ok: false, code: 'unauthorized' }
  }
  const verified = verifyDeviceProof({
    devicePublicKeyB64: resolution.devicePublicKeyB64,
    deviceProofB64: auth.deviceProofB64,
    purpose: 'auth',
    transcriptHashB64: args.v2Session.transcriptHashB64
  })
  return verified
    ? { ok: true, device: resolution.device, clientCapabilities: auth.clientCapabilities }
    : { ok: false, code: 'bad_proof' }
}

// Why: sealed, so only the pinned host can tell a client its key is revoked (it then deletes it);
// 'Unauthorized' marks an unpaired device for the re-pair prompt, storage trouble is not one.
export function describeMobileE2EEAuthFailure(failure: {
  code: MobileE2EEAuthFailureCode
  deviceId?: string
}): { sealedError: unknown; closeReason: string } {
  const closeReason =
    failure.code === 'unauthorized' || failure.code === 'device_revoked'
      ? 'Unauthorized'
      : failure.code === 'registry_unavailable'
        ? 'Device registry unavailable'
        : failure.code === INSECURE_WEB_ORIGIN_AUTH_CODE
          ? 'Insecure web origin'
          : failure.code === 'bad_auth' || failure.code === 'bad_proof'
            ? 'Invalid e2ee_auth'
            : 'Pairing ticket refused'
  return {
    sealedError: {
      type: 'e2ee_error',
      error: { code: failure.code, ...(failure.deviceId ? { deviceId: failure.deviceId } : {}) }
    },
    closeReason
  }
}

export function decodeMobileE2EEPublicKey(value: string): Uint8Array | null {
  try {
    return publicKeyFromBase64(value)
  } catch {
    return null
  }
}
