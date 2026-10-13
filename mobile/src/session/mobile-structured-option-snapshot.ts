import { createNativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'

/** The host's saved choice with this phone's still-pending pick on top. */
export function mobileStructuredOptionSnapshot(
  agent: string,
  state: StructuredAgentSessionOptionState,
  hostSelection: Readonly<Record<string, string>> | undefined
): SessionOptionDescriptor[] {
  const selected = hostSelection
    ? commitStructuredAgentSessionOptionValues(
        { ...state, record: createNativeChatSessionOptionRecord(agent) },
        hostSelection
      )
    : state
  const pending = state.pendingPick
  return structuredAgentSessionOptionSnapshot(
    pending
      ? commitStructuredAgentSessionOptionValues(selected, { [pending.id]: pending.value })
      : selected
  )
}
