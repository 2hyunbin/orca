import type { SessionOptionDescriptor } from './native-chat-session-options'
import type { AgentSessionExecutionOptions } from './agent-session-execution-options'

/** What the picker displayed at Send, excluding launch-only permission. */
export function agentSessionExecutionOptionsFromSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): AgentSessionExecutionOptions {
  const selected: Record<string, string> = {}
  for (const descriptor of snapshot) {
    if (
      descriptor.transport !== 'agent-session' ||
      descriptor.valueSource === 'unknown' ||
      !['model', 'effort', 'personality', 'fastMode', 'serviceTier'].includes(descriptor.id)
    ) {
      continue
    }
    const value = descriptor.kind.currentValue
    if (value !== undefined) {
      selected[descriptor.id] = String(value)
    }
  }
  return selected
}
