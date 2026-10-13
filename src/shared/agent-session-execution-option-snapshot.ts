import type { SessionOptionDescriptor } from './native-chat-session-options'
import type { AgentSessionExecutionOptions } from './agent-session-execution-options'

/** What the picker displayed at Send, excluding launch-only permission. */
export function agentSessionExecutionOptionsFromSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): AgentSessionExecutionOptions | undefined {
  const choices = ['model', 'effort', 'personality', 'fastMode', 'serviceTier']
  const descriptors = snapshot.filter(
    (descriptor) => descriptor.transport === 'agent-session' && choices.includes(descriptor.id)
  )
  if (
    descriptors.length === 0 ||
    descriptors.some((descriptor) => descriptor.valueSource === 'unknown')
  ) {
    return undefined
  }
  const selected: Record<string, string> = {}
  for (const descriptor of descriptors) {
    const value = descriptor.kind.currentValue
    if (value !== undefined) {
      selected[descriptor.id] = String(value)
    }
  }
  return selected
}
