// A chat's options at rest come from the host catalog without waiting on a listing.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'
import { AcpStructuredOptions, writeAcpSessionOption } from '../../acp/acp-structured-options'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { GROK_CONFIG_OPTIONS } from '../../acp/acp-structured-adapter.test-support'
import { SessionConfigOptionSchema } from '../../acp/generated/acp-protocol.generated'
import { withLiveCatalogListing } from '../agent-model-catalog/agent-model-catalog-entry'
import { agentModelCatalogFingerprintForRecord } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import {
  NO_STRUCTURED_AGENTS,
  structuredAgentsDeclaringNothing
} from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

function restingRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    sessionId: SESSION,
    launchDirectory: '/repo',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    location: { executionHostId: 'local', wslDistro: null },
    options: {}
  } as unknown as AgentSessionRecord
}

describe('options at rest', () => {
  it('keeps the account model for an older client when the starting child has no folder default', async () => {
    const record = restingRecord()
    const read = vi.fn(async (params: { inSessionWorkspace?: true }) => ({
      origin: 'probe' as const,
      models: [
        {
          id: params.inSessionWorkspace ? 'gpt-folder' : 'gpt-account',
          label: 'Model',
          isDefault: !params.inSessionWorkspace,
          efforts: []
        }
      ],
      fetchedAt: 1
    }))
    const starting = {
      child: { phase: 'starting' },
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, context: { floor: () => null } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: {},
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record },
        modelCatalog: { read }
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => starting,
      conversation: async () => starting
    } as unknown as StructuredAgentSessionMutationContext

    const current = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: true
    })
    expect(current.current).toEqual({ permissionMode: 'ask' })
    expect(read).toHaveBeenCalledTimes(1)
    const older = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    expect(older.current).toEqual({ model: 'gpt-account', permissionMode: 'ask' })
    expect(read).toHaveBeenLastCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      savedOnly: true,
      legacy: true,
      accountDefault: true
    })
  })

  it.each(['omp', 'grok', 'opencode'] as const)(
    '%s keeps an unknown model and binds later effort picks to the live model',
    async (provider) => {
      const record = { ...restingRecord(), provider }
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const store = new AgentModelCatalogStore()
      const modelCatalog = createAgentModelCatalogService({
        store,
        getRecord: () => record,
        drivesRecord: () => true,
        recordWorkspacePath: async () => '/repo',
        resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/homes/a' }),
        probes: { codex: probe }
      })
      let live = false
      const reader = new AcpStructuredOptions()
      const configOptions = SessionConfigOptionSchema.array().parse(GROK_CONFIG_OPTIONS)
      const resting = {
        child: null,
        params: { provider },
        journal: { threadGoal: () => null, context: { floor: () => null } }
      }
      const running = { ...resting, child: { fence: 7 } }
      const spec = acpLaunchSpecFor(provider)
      if (!spec) {
        throw new Error('Missing ACP test launch')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: options reads touch only these context members.
      const context = {
        deps: {
          adapter: { readOptions: async () => withLiveCatalogListing(reader.read()) },
          agents: structuredAgentsDeclaringNothing([acpStructuredAgentDefinition(spec)]),
          store: { getRecord: () => record },
          modelCatalog
        },
        serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
        openConversation: async () => (live ? running : resting),
        conversation: async () => (live ? running : resting)
      } as unknown as StructuredAgentSessionMutationContext

      const read = () =>
        readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
      const result = await read()
      expect(probe).not.toHaveBeenCalled()
      expect(result.models).toEqual([])
      expect(result.current).not.toHaveProperty('model')
      record.options = { model: 'later-model', effort: 'off' }
      expect((await read()).current).toEqual({
        model: 'later-model',
        effort: 'off',
        permissionMode: 'ask'
      })
      for (const emptyStart of [false, true]) {
        modelCatalog.recordLiveListing(SESSION, {
          models: [{ id: 'old', label: 'Old', isDefault: true, efforts: [] }]
        })
        reader.adoptSession(emptyStart ? {} : { configOptions })
        modelCatalog.recordLiveListing(SESSION, reader.startListing())
        const liveConfig = configOptions.map((option) =>
          option.type === 'select' && option.category === 'model'
            ? { ...option, currentValue: 'grok-4.6' }
            : option
        )
        reader.adoptConfigOptions(liveConfig)
        record.options = { model: 'grok-4.7', effort: 'off' }
        live = true
        const shown = await read()
        expect(shown.current.model).toBe('grok-4.6')
        expect(shown.current.confirmed).toEqual(['model', 'effort'])
        expect(shown.models.find((row) => row.id === 'grok-4.7')?.efforts).toEqual([])
        const write = reader.write('effort', 'low')
        if (!write) {
          throw new Error('Missing advertised effort write')
        }
        const setConfigOption = vi.fn(async () => ({
          configOptions: liveConfig.map((option) =>
            option.type === 'select' && option.category === 'thought_level'
              ? { ...option, currentValue: 'low' }
              : option
          )
        }))
        const setModel = vi.fn(async () => ({}))
        await writeAcpSessionOption({ setConfigOption, setModel }, reader, write, {
          agent: provider,
          timeoutMs: 1_000
        })
        expect(setConfigOption).toHaveBeenCalledExactlyOnceWith('reasoning_effort', 'low')
        expect(setModel).not.toHaveBeenCalled()
        expect(reader.reported()).toEqual({ model: 'grok-4.6', effort: 'low' })
        record.options = { model: 'grok-4.6', effort: 'high' }
        live = false
        const answer = await read()
        expect(answer.models).toEqual(reader.read().models)
      }
      const switched = reader.startListing()
      reader.adoptSession({ configOptions })
      const discovery = reader.startListing()
      store.recordSuccess(
        agentModelCatalogFingerprintForRecord(record),
        provider,
        { ...discovery, origin: 'probe' },
        'discovery'
      )
      modelCatalog.recordLiveListing(SESSION, switched)
      expect((await read()).models.find((row) => row.id === 'grok-4.7')?.efforts).toEqual(
        discovery.models.find((row) => row.id === 'grok-4.7')?.efforts
      )
      modelCatalog.recordLiveListing(SESSION, {
        models: [{ id: 'grok-4.7', label: 'Grok 4.7', isDefault: false, efforts: [] }]
      })
      expect((await read()).models.find((row) => row.id === 'grok-4.7')?.efforts).toEqual([])
    }
  )
})

describe('live Codex option reads', () => {
  it('keeps newer saved picks after a cold live listing waits without holding the session lane', async () => {
    const listing = Promise.withResolvers<void>()
    const queue = new StructuredAgentSessionTaskQueue()
    const child = { fence: 7 }
    const record = restingRecord()
    const apply = vi.fn(() => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', efforts: [] }],
      current: { model: 'gpt-live', effort: 'high', confirmed: ['model', 'effort'] as const }
    }))
    const prepareReadOptions = vi.fn(async () => {
      await listing.promise
      return apply
    })
    const live = {
      child,
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: { prepareReadOptions },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    const reading = readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    await vi.waitFor(() =>
      expect(prepareReadOptions).toHaveBeenCalledWith({
        sessionId: SESSION,
        fence: 7,
        legacyCatalog: true
      })
    )
    await expect(queue.serialize(SESSION, async () => 'delivery can proceed')).resolves.toBe(
      'delivery can proceed'
    )
    expect(apply).not.toHaveBeenCalled()
    record.options = { model: 'gpt-next', effort: 'low' }
    listing.resolve()
    await expect(reading).resolves.toMatchObject({
      current: { model: 'gpt-next', effort: 'low', confirmed: [] }
    })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('keeps a listing failure visible to the picker', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    const live = {
      child: { fence: 7 },
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, context: { floor: () => null } }
    }
    const failure = new Error('model/list unavailable')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failed read ends before touching the remaining context fields.
    const context = {
      deps: {
        adapter: {
          prepareReadOptions: async () => {
            throw failure
          }
        },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => restingRecord() }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    await expect(
      readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    ).rejects.toBe(failure)
    await expect(queue.serialize(SESSION, async () => 'Stop can proceed')).resolves.toBe(
      'Stop can proceed'
    )
  })

  it.each(['prepared', 'inventory'] as const)(
    'drops replaced-child facts after a late %s read',
    async (stage) => {
      const listing = Promise.withResolvers<void>()
      const queue = new StructuredAgentSessionTaskQueue()
      let blocked = false
      const entered = Promise.withResolvers<void>()
      const wait = async () => {
        entered.resolve()
        await listing.promise
      }
      const apply = vi.fn(() => ({
        models: [
          {
            id: 'stale',
            label: 'stale',
            isDefault: false,
            efforts: [],
            effortsKnown: false as const,
            supportsFastMode: true
          }
        ],
        fastModeSupport: { supported: true },
        current: { model: 'stale', fastMode: true }
      }))
      const prepareReadOptions = vi.fn(async () => {
        if (blocked && stage === 'prepared') {
          await wait()
        }
        return apply
      })
      const live = {
        child: { fence: 7 },
        params: { provider: 'codex' },
        journal: { threadGoal: () => null, context: { floor: () => null } }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
      const context = {
        deps: {
          adapter: { prepareReadOptions },
          agents: NO_STRUCTURED_AGENTS,
          store: { getRecord: () => restingRecord() },
          modelCatalog: {
            read: async () => {
              if (blocked && stage === 'inventory') {
                await wait()
              }
              return {
                origin: 'probe',
                fetchedAt: 1,
                models: [{ id: 'installed', label: 'installed', isDefault: true, efforts: [] }]
              }
            }
          }
        },
        serialize: (sessionId: string, task: () => Promise<unknown>) =>
          queue.serialize(sessionId, task),
        openConversation: async () => live,
        conversation: async () => live
      } as unknown as StructuredAgentSessionMutationContext

      const read = () =>
        readStructuredAgentSessionOptions(context, SESSION, {
          readsWithoutModel: true,
          readsCoherentCatalog: true
        })
      const initial = await read()
      expect(initial.models.map((row) => row.id)).toEqual(['installed', 'stale'])
      expect(initial.models.find((row) => row.id === 'stale')).toMatchObject({
        supportsFastMode: true
      })
      expect(initial.current.fastMode).toBe(true)
      blocked = true
      const reading = read()
      await entered.promise
      await queue.serialize(SESSION, async () => {
        live.child = { fence: 8 }
      })
      listing.resolve()
      const replaced = await reading
      expect(replaced.current).not.toHaveProperty('model')
      expect(replaced.models.every((row) => row.supportsFastMode !== true)).toBe(true)
      expect(apply).toHaveBeenCalledTimes(stage === 'prepared' ? 1 : 2)
    }
  )
})
