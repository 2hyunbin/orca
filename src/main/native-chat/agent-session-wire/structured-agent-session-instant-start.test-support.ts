// Fake providers publish their generation and return protocol facts from host-awaited open.

import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export function startsWhenPublished<A extends StructuredAgentSessionAdapter>(
  adapter: A,
  _host: () => unknown
): A & StructuredAgentSessionAdapter {
  const spawn: StructuredAgentSessionAdapter['spawn'] = async (input) => {
    const acquired = await adapter.spawn(input)
    if (!acquired.acquisitionGeneration) {
      throw new Error('test provider did not publish its generation')
    }
    return acquired
  }
  return { ...adapter, spawn }
}
