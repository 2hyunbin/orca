import { useCallback, useMemo } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { cloneNativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'

/** A menu pick returns the latest held launch value even before React renders it. */
export function useStructuredAgentSessionOptionSurface(args: {
  sessionId: string
  optionView: StructuredAgentSessionOptionState
  optionSnapshot: SessionOptionDescriptor[]
  changeOption: (
    id: string,
    value: string | boolean
  ) => Promise<Readonly<Record<string, string>> | null>
}): SessionOptionsSurface {
  const { sessionId, optionView, optionSnapshot, changeOption } = args
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      const committed = await changeOption(id, value)
      const held = getStructuredAgentSessionLaunchSelection(sessionId)?.held
      const selected = committed
        ? commitStructuredAgentSessionOptionValues(
            { ...optionView, record: cloneNativeChatSessionOptionRecord(optionView.record) },
            committed
          )
        : optionView
      return {
        snapshot: structuredAgentSessionOptionSnapshot(
          structuredAgentSessionOptionView(selected, undefined, held ?? {})
        )
      }
    },
    [changeOption, optionView, sessionId]
  )
  return useMemo(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [setOption, optionSnapshot]
  )
}
