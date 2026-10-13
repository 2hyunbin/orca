// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import {
  forgetHostModelCatalogSnapshots,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL = { kind: 'local' } as const
const MODELS = ['gpt-one', 'gpt-two'].map((id) => ({
  id,
  label: id,
  isDefault: false,
  efforts: [
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ]
}))
const LAUNCH = { kind: 'new' as const, heldOptions: {}, worktree: 'folder:one' }
const EMPTY_SELECTION = {}
const NO_MUTATE: StructuredAgentSessionMutate = async () => null

function catalog(defaultModel = 'gpt-one'): AgentSessionModelCatalogResult {
  return {
    origin: 'live-session',
    models: MODELS.map((model) => ({
      ...model,
      isDefault: model.id === defaultModel,
      ...(model.id === defaultModel ? { defaultEffort: 'medium' } : {})
    })),
    fetchedAt: 1,
    listingNamesConfiguredModel: true
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

function renderChat() {
  return renderHook(
    (fence: number) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target: LOCAL,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        optionSelection: EMPTY_SELECTION,
        fence,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate: NO_MUTATE,
        launch: LAUNCH
      }),
    { initialProps: 1 }
  )
}

function selected(view: ReturnType<typeof renderChat>) {
  return Object.fromEntries(
    view.result.current.optionSnapshot.map((option) => [
      option.id,
      option.kind.type === 'select' ? (option.kind.currentValue ?? null) : null
    ])
  )
}

beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

it.each(['catalog-first', 'options-first'] as const)(
  'uses the scoped default with an empty host selection after %s replies',
  async (order) => {
    const listing = deferred<AgentSessionModelCatalogResult>()
    const options = deferred<AgentSessionOptionsResult>()
    const metadata: AgentSessionOptionsResult = {
      models: MODELS,
      current: { model: 'gpt-two', effort: 'high' },
      conversationCommands: ['clear']
    }
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.modelCatalog' ? listing.promise : options.promise
    )
    const view = renderChat()
    await act(async () => {
      if (order === 'catalog-first') {
        listing.resolve(catalog())
      } else {
        options.resolve(metadata)
      }
    })
    await act(async () => {
      listing.resolve(catalog())
      options.resolve(metadata)
    })
    await waitFor(() => expect(view.result.current.conversationCommands).toHaveLength(1))
    expect(selected(view)).toEqual({ model: 'gpt-one', effort: 'medium' })
    view.unmount()
  }
)

it.each(['folder config', 'account'] as const)(
  'refreshes an empty selection default after the %s changes',
  async (change) => {
    recordHostModelCatalogSnapshot(LOCAL, 'codex', LAUNCH.worktree, catalog())
    let defaultModel = 'gpt-one'
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.modelCatalog'
        ? catalog(defaultModel)
        : { models: MODELS, current: {} }
    )
    const view = renderChat()
    await waitFor(() => expect(view.result.current.rewind).toBeDefined())
    expect(selected(view)).toEqual({ model: 'gpt-one', effort: 'medium' })
    defaultModel = 'gpt-two'
    if (change === 'account') {
      forgetHostModelCatalogSnapshots(LOCAL, ['codex'])
    }
    recordHostModelCatalogSnapshot(LOCAL, 'codex', LAUNCH.worktree, catalog(defaultModel))
    view.rerender(1)
    expect(selected(view)).toEqual({ model: 'gpt-two', effort: 'medium' })
    view.rerender(2)
    await waitFor(() => expect(view.result.current.rewind).toBeDefined())
    expect(selected(view)).toEqual({ model: 'gpt-two', effort: 'medium' })
    view.unmount()
  }
)
