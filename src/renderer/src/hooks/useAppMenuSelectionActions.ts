import { awaitSelectedNativeChatInput } from '@/components/native-chat/native-chat-input-readiness'
import { useEffect } from 'react'
import {
  dispatchAppMenuSelectionAction,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'

export function useAppMenuSelectionActions(): void {
  useEffect(() => {
    return window.api.ui.onAppMenuSelectionAction(async (action: AppMenuSelectionAction) => {
      if (action === 'select-all') {
        const input = await awaitSelectedNativeChatInput()
        if (input === false) {
          return
        }
        input?.focus({ preventScroll: true })
      }
      if (!dispatchAppMenuSelectionAction(action)) {
        window.api.ui.performNativeSelectionAction(action)
      }
    })
  }, [])
}
