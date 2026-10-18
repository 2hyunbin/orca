import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'
import {
  getTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

/** A model the list lacks has no effort menu, so the chat's own effort under it shows read-only:
 *  no list says which levels it takes, and a send carries the value unchanged. */
export function withUnlistedEffort(
  catalog: AgentSessionOptionCatalog,
  record: NativeChatSessionOptionRecord,
  /** The ids the chat's own options answer lists; absent from an older host. */
  listed: readonly string[] | undefined,
  snapshot: SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  const modelId = resolveEffectiveNativeChatModelId(catalog, catalog.models, record)
  const effort = getTrackedSessionOption(record, modelId, 'effort')
  // A listed model with no effort menu takes none: only an unlisted one keeps its own.
  if (
    !modelId ||
    !listed ||
    listed.includes(modelId) ||
    typeof effort?.value !== 'string' ||
    snapshot.some((entry) => entry.id === 'effort')
  ) {
    return snapshot
  }
  // Named as a listed model's effort row names the same level.
  const listedLevel = catalog.models
    .flatMap((model) => model.options)
    .find((option) => option.id === 'effort')
  const level =
    listedLevel?.kind.type === 'select'
      ? listedLevel.kind.choices.find((choice) => choice.value === effort.value)
      : undefined
  const descriptor: SessionOptionDescriptor = {
    id: 'effort',
    label: listedLevel?.label ?? 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      currentValue: effort.value,
      choices: [level ?? { value: effort.value, label: effort.value }]
    },
    valueSource: effort.source,
    transport: 'agent-session',
    settable: false
  }
  return [...snapshot, descriptor]
}
