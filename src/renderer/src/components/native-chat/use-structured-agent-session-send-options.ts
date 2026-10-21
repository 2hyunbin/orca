import { useCallback } from 'react'
import type { StructuredAgentSessionSendControl } from '../../../../shared/structured-agent-session-send-mutation'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionSendSelection
} from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

/** What each send carries to a host that takes it: the chat's own model and effort, picks over them. */
export function useStructuredAgentSessionSendOptions(
  sessionId: string,
  launch: StructuredAgentSessionLaunchView | undefined,
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    'optionStateRef' | 'optionView' | 'takesSendOptions' | 'takesSelection'
  >
): () => Pick<StructuredAgentSessionSendControl, 'options' | 'selection'> {
  const { optionStateRef, optionView, takesSendOptions, takesSelection } = source
  return useCallback(() => {
    if (!takesSendOptions && !takesSelection) {
      return {}
    }
    // Read, not rendered: a pick the launch just took is not in this render's props yet.
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    // A pick on its way resolves as the picker shows it.
    const view = optionView(optionStateRef.current, selection?.seed ?? launch?.seedOptions, {
      ...(selection?.held ?? launch?.heldOptions)
    })
    return takesSelection
      ? { selection: structuredAgentSessionMessageSelection(view) }
      : { options: structuredAgentSessionSendSelection(view) }
  }, [launch, optionStateRef, optionView, sessionId, takesSendOptions, takesSelection])
}
