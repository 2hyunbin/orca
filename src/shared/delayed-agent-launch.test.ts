import { describe, expect, it } from 'vitest'
import { detectExplicitPiAgentKindFromCommand } from './pi-agent-kind'
import { selectOpenCodeHookAgent } from './opencode-launch-command'

describe('delayed agent launch preparation', () => {
  it.each(['pi', 'omp', 'prime-agent'] as const)(
    'prepares the %s integration after sleep',
    (agent) => {
      expect(detectExplicitPiAgentKindFromCommand(`sleep 30 && ${agent}`)).toBe(agent)
    }
  )

  it('selects OpenCode 2 hooks after sleep instead of the v1 fallback', () => {
    expect(selectOpenCodeHookAgent(undefined, 'sleep 30 && opencode2', () => true)).toBe(
      'opencode2'
    )
    expect(
      selectOpenCodeHookAgent(undefined, 'sleep 30 && opencode2', (agent) => agent === 'opencode')
    ).toBeNull()
  })
})
