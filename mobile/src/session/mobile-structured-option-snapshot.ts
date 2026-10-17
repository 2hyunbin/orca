import { createNativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from '../../../src/shared/structured-agent-session-option-view'

/** The host's saved choice with this phone's still-pending pick on top, as the picker shows it. */
export function mobileStructuredOptionSnapshot(
  agent: string,
  state: StructuredAgentSessionOptionState,
  hostSelection: Readonly<Record<string, string>> | undefined,
  takesSendOptions: boolean
): SessionOptionDescriptor[] {
  const selected = hostSelection
    ? commitStructuredAgentSessionOptionValues(
        { ...state, record: createNativeChatSessionOptionRecord(agent) },
        hostSelection
      )
    : state
  const pending = state.pendingPick
  return structuredAgentSessionShownSnapshot(
    pending
      ? commitStructuredAgentSessionOptionValues(selected, { [pending.id]: pending.value })
      : selected,
    takesSendOptions
  )
}
