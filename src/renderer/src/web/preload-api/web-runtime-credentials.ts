import { readWebDeviceKeySupport } from '../web-device-key-support'
import type { WebDeviceSigningKey } from '../web-device-key'
import {
  createIndexedDbWebDeviceKeyStore,
  createMemoryWebDeviceKeyStore,
  type WebDeviceKeyStore
} from '../web-device-key-store'
import {
  createWebRuntimeCredentialSource,
  tokenOnlyCredentialSource,
  type WebRuntimeCredentialSource
} from '../web-runtime-credential-source'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'

let keyStore: WebDeviceKeyStore | null = null
const sources = new Map<string, WebRuntimeCredentialSource>()
// Session keys registered by a ticket redemption on this page, by pairing.
const sessionDevices = new Map<string, { deviceId: string; key: WebDeviceSigningKey }>()

function pairingKeyOf(environment: StoredWebRuntimeEnvironment, publicKeyB64?: string): string {
  return `${environment.id}\0${environment.pairingRevision ?? environment.createdAt}\0${publicKeyB64}`
}

/** The browser's device key store (IndexedDB, or memory where IndexedDB is missing). */
export function webDeviceKeyStore(): WebDeviceKeyStore {
  keyStore ??=
    typeof indexedDB === 'undefined'
      ? createMemoryWebDeviceKeyStore()
      : createIndexedDbWebDeviceKeyStore(indexedDB)
  return keyStore
}

/** Lets this page's later sockets sign in with the session key a ticket redemption registered. */
export function rememberWebSessionDevice(
  environment: StoredWebRuntimeEnvironment,
  device: { deviceId: string; key: WebDeviceSigningKey }
): void {
  sessionDevices.set(pairingKeyOf(environment, environment.endpoints[0]?.publicKeyB64), device)
}

/**
 * One credential source per pairing, shared by the primary client and its helper sockets so a
 * key registered by one is used by all. Keyed by pairing revision: a re-pair starts fresh.
 */
export function webRuntimeCredentialFor(
  environment: StoredWebRuntimeEnvironment,
  callbacks: {
    forgetStoredToken: (deviceId: string) => void
    forgetPairing: () => void
  }
): WebRuntimeCredentialSource {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  const cacheKey = pairingKeyOf(environment, endpoint?.publicKeyB64)
  const existing = sources.get(cacheKey)
  if (existing) {
    return existing
  }
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  const support = readWebDeviceKeySupport()
  if (!support) {
    return tokenOnlyCredentialSource(endpoint.deviceToken)
  }
  const sessionDevice = sessionDevices.get(cacheKey)
  const source = createWebRuntimeCredentialSource({
    environment: {
      environmentId: environment.id,
      hostPublicKeyB64: endpoint.publicKeyB64,
      deviceToken: endpoint.deviceToken,
      pairingRevision: environment.pairingRevision ?? environment.createdAt,
      storage: environment.sessionOnly ? 'session' : 'persisted',
      ...(sessionDevice ? { sessionDevice } : {})
    },
    support,
    store: webDeviceKeyStore(),
    subtle: typeof crypto === 'undefined' ? null : crypto.subtle,
    ...callbacks
  })
  sources.set(cacheKey, source)
  return source
}
