import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { PairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  createSessionDeviceSigningKey,
  getOrCreatePendingWebDeviceKey,
  webDeviceSigningKey,
  type WebDeviceKeySupport,
  type WebDeviceSigningKey
} from './web-device-key'
import { webDeviceKeyId, type WebDeviceKeyStore } from './web-device-key-store'
import { isWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import {
  MIGRATED_DEVICE_TOKEN_PREFIX,
  type WebRuntimeCredentialSource
} from './web-runtime-credential-source'
import {
  createStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { createWebTicketCredentialSource } from './web-ticket-credential-source'

// Why: the desktop owner has two minutes to approve; status.get waits for the whole window.
const TICKET_PAIRING_TIMEOUT_MS = 2 * 60_000 + 30_000

type TicketPairingClient = {
  call: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<RuntimeRpcResponse<unknown>>
  close: () => void
}

export type WebTicketPairingDeps = {
  support: WebDeviceKeySupport | null
  store: WebDeviceKeyStore
  subtle: SubtleCrypto | null
  deviceLabel: string
  createClient: (
    connection: PairedRuntimeConnection,
    options: {
      credential: WebRuntimeCredentialSource
      onPairingComparisonCode: (code: string) => void
    }
  ) => TicketPairingClient
  rememberSessionDevice: (
    environment: StoredWebRuntimeEnvironment,
    device: { deviceId: string; key: WebDeviceSigningKey }
  ) => void
}

/**
 * Pairs this browser by redeeming a single-use ticket. The stored environment never holds a
 * token: its endpoint carries a non-secret placeholder, and the browser signs in with its key.
 */
export async function pairWebBrowserWithTicket(args: {
  offer: PairingTicketOffer
  name: string
  previousEnvironment: StoredWebRuntimeEnvironment | null
  onComparisonCode: (code: string) => void
  deps: WebTicketPairingDeps
}): Promise<StoredWebRuntimeEnvironment> {
  const { offer, deps } = args
  const placeholder = `${MIGRATED_DEVICE_TOKEN_PREFIX}${offer.deviceId}`
  const environment = createStoredWebRuntimeEnvironment({
    name: args.name,
    offer: {
      v: 2,
      endpoint: offer.endpoint,
      deviceToken: placeholder,
      publicKeyB64: offer.publicKeyB64,
      pairedDeviceId: offer.deviceId,
      scope: offer.scope,
      ...(offer.hostDescriptor ? { hostDescriptor: offer.hostDescriptor } : {})
    },
    previousEnvironment: args.previousEnvironment
  })
  const persistent = deps.support === 'persistent' && deps.subtle !== null
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  const recordId = webDeviceKeyId(offer.publicKeyB64, environment.id)
  // Why a per-ticket record: a re-pair to the same host must never reuse (or, on refusal, delete)
  // the key the existing pairing signs in with; it replaces that key only once the host confirms.
  const attemptId = `${recordId}|ticket:${offer.deviceId}`
  const key =
    persistent && deps.subtle
      ? webDeviceSigningKey(
          deps.subtle,
          await getOrCreatePendingWebDeviceKey(deps.store, deps.subtle, attemptId, pairingRevision)
        )
      : createSessionDeviceSigningKey()
  const client = deps.createClient(
    {
      endpoint: offer.endpoint,
      hostPublicKeyB64: offer.publicKeyB64,
      credential: { kind: 'token', deviceToken: placeholder },
      pairedDeviceId: offer.deviceId
    },
    {
      credential: createWebTicketCredentialSource({
        ticket: offer.ticket,
        deviceId: offer.deviceId,
        key,
        deviceLabel: deps.deviceLabel,
        ephemeral: !persistent
      }),
      onPairingComparisonCode: args.onComparisonCode
    }
  )
  try {
    const response = await client.call('status.get', undefined, {
      timeoutMs: TICKET_PAIRING_TIMEOUT_MS
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    if (persistent) {
      const attempt = await deps.store.get(attemptId)
      if (!attempt || attempt.publicKeyB64 !== key.publicKeyB64) {
        throw new Error('The device key changed while this browser was pairing')
      }
      await deps.store.put({
        ...attempt,
        id: recordId,
        state: 'active',
        deviceId: offer.deviceId,
        pairingRevision
      })
      await deps.store.remove(attemptId)
    } else {
      deps.rememberSessionDevice(environment, { deviceId: offer.deviceId, key })
    }
    return { ...environment, runtimeId: response._meta.runtimeId, lastUsedAt: Date.now() }
  } catch (error) {
    // Why only on a sealed refusal: a lost reply may still have committed this key.
    if (persistent && isWebRuntimeUnauthorizedError(error)) {
      await removePendingAttempt(deps.store, attemptId, key.publicKeyB64)
    }
    throw error
  } finally {
    client.close()
  }
}

async function removePendingAttempt(
  store: WebDeviceKeyStore,
  attemptId: string,
  publicKeyB64: string
): Promise<void> {
  try {
    const attempt = await store.get(attemptId)
    if (attempt?.state === 'pending' && attempt.publicKeyB64 === publicKeyB64) {
      await store.remove(attemptId)
    }
  } catch {
    // A leftover pending record is harmless; it is never used to sign in.
  }
}

/** A readable, non-identifying label such as "Chrome on macOS" for the owner's device list. */
export function webBrowserDeviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Web browser'
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null
  return os ? `${browser} on ${os}` : browser
}
