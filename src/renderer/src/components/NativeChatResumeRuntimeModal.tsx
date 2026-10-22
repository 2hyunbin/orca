import { useSyncExternalStore } from 'react'
import type { NativeChatRestartStore } from './native-chat-resume-on-restart-store'
import { NativeChatResumeOccurrenceModal } from './NativeChatResumeOnRestartModal'

export function NativeChatResumeRuntimeModal({
  store,
  machineName,
  offerEnabled
}: {
  store: NativeChatRestartStore
  machineName?: string
  offerEnabled: boolean
}): React.JSX.Element | null {
  const occurrence = useSyncExternalStore(
    store.subscribe,
    store.getNativeChatRestartOccurrence,
    store.getNativeChatRestartOccurrence
  )
  return (
    <NativeChatResumeOccurrenceModal
      key={occurrence.identity}
      store={store}
      machineName={machineName}
      offerEnabled={offerEnabled}
    />
  )
}
