import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../shared/structured-agent-session-options'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { PI_RPC_AGENT } from '../../pi/rpc-agent-definition'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

const DEFINITIONS = [
  CODEX_STRUCTURED_AGENT,
  acpStructuredAgentDefinition(acpLaunchSpecFor('grok')!),
  PI_RPC_AGENT,
  CLAUDE_STRUCTURED_AGENT
]
const MODELS = [
  {
    id: 'configured-model',
    label: 'Configured model',
    isDefault: true,
    defaultEffort: 'high',
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  }
]

function coldChat(definition: (typeof DEFINITIONS)[number], starting: boolean) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are all the record fields the options read and catalog fingerprint access.
  const record = {
    provider: definition.agent,
    accountHome: { variable: 'TEST_AGENT_HOME', path: '/test/account' },
    location: { executionHostId: 'local', wslDistro: null },
    options: {}
  } as unknown as AgentSessionRecord
  const listing = Promise.withResolvers<AgentModelCatalogSuccess>()
  const probe = vi.fn(() => listing.promise)
  const modelCatalog = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    recordWorkspacePath: async () => '/test/folder',
    workspaceMayOverrideDefaultModel: async () => false,
    listingNamesConfiguredModel: new Set([definition.agent]),
    probes: { [definition.agent]: probe }
  })
  const resting = {
    child: starting ? { phase: 'starting' } : null,
    params: { provider: definition.agent },
    journal: { context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting path accesses only these context members; no provider process runs.
  const context = {
    deps: {
      adapter: {},
      agents: { definition: () => definition, capabilities: () => null },
      store: { getRecord: () => record },
      modelCatalog
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  const read = (sessionId = 'first-chat') =>
    readStructuredAgentSessionOptions(context, sessionId, { readsWithoutModel: true })
  return { listing, probe, modelCatalog, read }
}

describe.each(DEFINITIONS)('$agent first options read before its catalog loads', (definition) => {
  it.each([false, true])('fills the picker in place with starting=%s', async (starting) => {
    const chat = coldChat(definition, starting)
    const agent = definition.agent
    const seed = structuredAgentSessionSeedCatalog(agent)
    let state = createStructuredAgentSessionOptionState(agent, seed)
    const pending = await chat.modelCatalog.read({ agent, sessionId: 'first-chat' })
    expect(pending).toMatchObject({ origin: 'unknown', listingInProgress: true })
    const waiting = chat.modelCatalog.read({ agent, sessionId: 'first-chat', waitForListing: true })
    const options = await chat.read()
    expect(options.current.model).toBeUndefined()
    state = applyStructuredAgentSessionOptions(state, seed, options)
    const beforeListing = structuredAgentSessionOptionSnapshot(state)
    chat.listing.resolve({ origin: 'probe', models: MODELS })
    const loaded = await waiting
    state = applyStructuredAgentSessionModelCatalog(state, seed, loaded, { newLaunch: true })
    expect(structuredAgentSessionOptionSnapshot(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model',
          kind: expect.objectContaining({ currentValue: 'configured-model' })
        }),
        expect.objectContaining({
          id: 'effort',
          kind: expect.objectContaining({ currentValue: 'high' })
        })
      ])
    )
    expect(beforeListing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'model', settable: false, valueSource: 'unknown' })
      ])
    )
    expect(chat.probe).toHaveBeenCalledOnce()

    const secondOptions = await chat.read('second-chat')
    const second = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      secondOptions
    )
    expect(secondOptions.current).toMatchObject({ model: 'configured-model', effort: 'high' })
    expect(structuredAgentSessionOptionSnapshot(second)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model',
          kind: expect.objectContaining({ currentValue: 'configured-model' })
        })
      ])
    )
    expect(chat.probe).toHaveBeenCalledOnce()
    chat.modelCatalog.stop()
  })
})
