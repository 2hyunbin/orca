import { describe, expect, it } from 'vitest'
import { agentSessionExecutionOptionsFromSnapshot } from './agent-session-execution-option-snapshot'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

describe('message choices while the picker loads', () => {
  it.each(['codex', 'claude', 'pi'])('omits unknown %s choices', (agent) => {
    const seed = structuredAgentSessionSeedCatalog(agent)
    const state = createStructuredAgentSessionOptionState(agent, seed)
    expect(
      agentSessionExecutionOptionsFromSnapshot(structuredAgentSessionOptionSnapshot(state))
    ).toBeUndefined()
  })

  it.each([
    ['pi', 'anthropic/claude-sonnet-4-5'],
    ['codex', 'some-unlisted-model']
  ])('omits %s choices until its saved model is listed', (agent, model) => {
    const seed = structuredAgentSessionSeedCatalog(agent)
    const state = commitStructuredAgentSessionOptionValues(
      createStructuredAgentSessionOptionState(agent, seed),
      { model, effort: 'high' }
    )
    expect(
      agentSessionExecutionOptionsFromSnapshot(structuredAgentSessionOptionSnapshot(state))
    ).toBeUndefined()
  })
})
