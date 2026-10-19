import { useAppStore } from '../store'
import type { PairedTerminalTabCloseIntentStore } from './web-session-close-replay'

/** The app store's held paired-tab closes, as the replay module reads and settles them. */
export const appPairedTerminalTabCloseIntentStore: PairedTerminalTabCloseIntentStore = {
  getIntents: () => useAppStore.getState().pairedTerminalTabCloseIntentsByEnvironment,
  record: (environmentId, intent) =>
    useAppStore.getState().recordPairedTerminalTabCloseIntent(environmentId, intent),
  clear: (environmentId, intentKeys) =>
    useAppStore.getState().clearPairedTerminalTabCloseIntents(environmentId, intentKeys)
}
