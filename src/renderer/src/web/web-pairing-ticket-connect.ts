import type { PairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import { rememberWebSessionDevice, webDeviceKeyStore } from './preload-api/web-runtime-credentials'
import { readWebDeviceKeySupport } from './web-device-key-support'
import { pairWebBrowserWithTicket, webBrowserDeviceLabel } from './web-pairing-ticket-redemption'
import { WebRuntimeClient } from './web-runtime-client'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

/** The browser's real dependencies for a ticket pairing. */
export function connectWebBrowserWithTicket(args: {
  offer: PairingTicketOffer
  name: string
  previousEnvironment: StoredWebRuntimeEnvironment | null
  onComparisonCode: (code: string) => void
}): Promise<StoredWebRuntimeEnvironment> {
  return pairWebBrowserWithTicket({
    ...args,
    deps: {
      support: readWebDeviceKeySupport(),
      store: webDeviceKeyStore(),
      subtle: typeof crypto === 'undefined' ? null : crypto.subtle,
      deviceLabel: webBrowserDeviceLabel(navigator.userAgent),
      rememberSessionDevice: rememberWebSessionDevice,
      // Why reconnect: a lost reply is retried with the reserved id; a refusal still ends it.
      createClient: (connection, options) =>
        new WebRuntimeClient(connection, { ...options, reconnect: true })
    }
  })
}
