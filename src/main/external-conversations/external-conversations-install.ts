import type { GlobalSettings } from '../../shared/global-settings-types'
import { ExternalConversationSeam } from './external-conversation-seam'

type ConnectorSettingsStore = {
  getSettings(): Pick<GlobalSettings, 'experimentalConnectors'>
  onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
}

/**
 * Owns the connector seam's lifetime: one exists exactly while `experimentalConnectors` is on.
 * The host is the authority, so every connector entry point asks it rather than its own profile.
 */
export function installExternalConversations(store: ConnectorSettingsStore | null): {
  current(): ExternalConversationSeam | null
} {
  let seam: ExternalConversationSeam | null = null
  const reconcile = (enabled: boolean): void => {
    if (enabled && !seam) {
      seam = new ExternalConversationSeam()
    } else if (!enabled && seam) {
      seam.dispose('connectors_disabled')
      seam = null
    }
  }
  if (store) {
    const enabled = (): boolean => store.getSettings().experimentalConnectors === true
    reconcile(enabled())
    store.onSettingsChanged?.((updates) => {
      if ('experimentalConnectors' in updates) {
        reconcile(enabled())
      }
    })
  }
  return { current: () => seam }
}
