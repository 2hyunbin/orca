import { createContext, useMemo, type ReactNode } from 'react'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'

export const NativeChatMarkdownImageOwnerContext = createContext<{
  fileLinkContext: NativeChatFileLinkContext | null
  runtimeContext: NativeChatImageRuntimeContext
  isVisible: boolean
} | null>(null)

export function NativeChatMarkdownImageOwnerProvider({
  tabId,
  sessionId,
  isVisible,
  children
}: {
  tabId: string
  sessionId: string
  isVisible: boolean
  children: ReactNode
}): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(tabId, sessionId)
  const ownerRuntimeContext = useNativeChatImageRuntimeContext(tabId)
  // Why: an image outside every workspace on a paired host loads through the grant its chat earns.
  const runtimeContext = useMemo(
    () =>
      ownerRuntimeContext
        ? { ...ownerRuntimeContext, nativeChatContext: { tabId, sessionId } }
        : ownerRuntimeContext,
    [ownerRuntimeContext, tabId, sessionId]
  )
  const value = useMemo(
    () => ({ fileLinkContext, runtimeContext, isVisible }),
    [fileLinkContext, runtimeContext, isVisible]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={value}>
      {children}
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
