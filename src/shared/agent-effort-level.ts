// Why a shape, not Claude's level list: a level a newer Claude adds must still round-trip into argv.
const AGENT_EFFORT_LEVEL = /^[a-z][a-z0-9-]{0,31}$/

export function readAgentEffortLevel(value: unknown): string | undefined {
  return typeof value === 'string' && AGENT_EFFORT_LEVEL.test(value) ? value : undefined
}
