import { describe, expect, it } from 'vitest'
import { agentSessionExecutionOptionsFromSnapshot } from './agent-session-execution-option-snapshot'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'

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

describe('what a composer send carries', () => {
  const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
  function carried(
    pending: Record<string, string>,
    seed: Record<string, string> | undefined = { model: 'claude-gone', effort: 'max' }
  ) {
    const listed = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') },
          { id: 'sonnet', label: 'Sonnet', isDefault: true, efforts: levels('low', 'high') }
        ]
      },
      { newLaunch: true }
    )
    // A pick on its way is committed into the view the picker shows, as the option state does.
    const state = commitStructuredAgentSessionOptionValues(listed, pending)
    return agentSessionExecutionOptionsFromSnapshot(
      structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(state, seed, {}, true))
    )
  }

  it('carries the shown model and effort, a gone Claude model moved to the listed default', () => {
    expect(carried({})).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  it('carries the default the composer shows when nothing names a model', () => {
    expect(carried({}, undefined)).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  it('carries a pick still on its way, resolved as the picker shows it', () => {
    expect(carried({ model: 'opus[1m]', effort: 'low' })).toMatchObject({
      model: 'opus[1m]',
      effort: 'low'
    })
    // A gone model the pick names moves to the listed default, its effort to the nearest offered.
    expect(carried({ model: 'claude-retired', effort: 'max' })).toMatchObject({
      model: 'sonnet',
      effort: 'high'
    })
  })
})
