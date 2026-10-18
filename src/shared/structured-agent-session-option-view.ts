import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

/**
 * What the picker shows before the host has confirmed this session's values:
 * `seed` (the selection a launch seeds) stands in until the record names a
 * model, and `held` picks outrank both until the host settles them.
 * All show as `dispatched`; derived on every read, never
 * written into the record.
 *
 * The permission mode reads its own way: the held pick, else what the host stated, else the seed.
 * A host that cannot take a send's model keeps running the chat's own, so that is what shows.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  _takesSendOptions: boolean
): StructuredAgentSessionOptionState {
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission, ...heldSelection } = held
  const view = modelOptionView(state, seed, heldSelection)
  const permissionMode =
    heldPermission ?? state.permissionMode ?? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

/** The picker of a client that holds no launch selection, such as the phone. */
export function structuredAgentSessionShownSnapshot(
  state: StructuredAgentSessionOptionState,
  takesSendOptions: boolean
): SessionOptionDescriptor[] {
  return structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(state, undefined, {}, takesSendOptions)
  )
}

function modelOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const unconfirmedSeed = seed !== undefined && state.record.model === undefined
  const hasHeld = Object.keys(held).length > 0
  const seeded = unconfirmedSeed
  if (!state.catalog || (!seeded && !hasHeld)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneNativeChatSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}

/** The Claude model and effort the composer shows (`snapshot`), which every send carries. */
export function structuredAgentSessionSendSelection(
  agent: string,
  snapshot: readonly SessionOptionDescriptor[],
  omitProvisional = true
): Record<string, string> | undefined {
  if (agent !== 'claude') {
    return undefined
  }
  const shown = (id: string): string | undefined => {
    const descriptor = snapshot.find((entry) => entry.id === id)
    if (omitProvisional && descriptor?.valueSource === 'default') {
      return undefined
    }
    const kind = descriptor?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  const model = shown('model')
  const effort = shown('effort')
  return model ? { model, ...(effort ? { effort } : {}) } : undefined
}
