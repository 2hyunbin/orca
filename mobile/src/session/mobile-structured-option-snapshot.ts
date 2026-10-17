import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../src/shared/structured-agent-session-option-view'

export function commitMobileStructuredOptions(
  state: StructuredAgentSessionOptionState,
  hostSelection: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  return commitStructuredAgentSessionOptionValues(state, { ...hostSelection, ...values })
}

/** Display, validation and send share the host selection and this phone's pending pick. */
export function mobileStructuredOptionView(
  state: StructuredAgentSessionOptionState,
  hostSelection: Readonly<Record<string, string>> | undefined,
  takesSendOptions: boolean,
  permissionMode?: string
): StructuredAgentSessionOptionState {
  return structuredAgentSessionOptionView(state, undefined, {}, takesSendOptions, {
    selection: hostSelection,
    permissionMode
  })
}

export function mobileStructuredOptionSnapshot(
  state: StructuredAgentSessionOptionState,
  hostSelection: Readonly<Record<string, string>> | undefined,
  takesSendOptions: boolean,
  permissionMode?: string
): SessionOptionDescriptor[] {
  return structuredAgentSessionOptionSnapshot(
    mobileStructuredOptionView(state, hostSelection, takesSendOptions, permissionMode)
  )
}
