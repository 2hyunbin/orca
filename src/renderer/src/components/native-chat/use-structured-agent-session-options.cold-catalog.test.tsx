// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL = { kind: 'local' } as const
const EMPTY_SELECTION = {}
const LAUNCH = { kind: 'new' as const, heldOptions: {}, worktree: 'folder:one' }
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
const LOADED: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: MODELS,
  fetchedAt: 1,
  listingNamesConfiguredModel: true
}

function renderChat(agent: string, selectionFromStatus: boolean, sessionId = 'first-chat') {
  const frames: string[][] = []
  const view = renderHook(() => {
    const options = useStructuredAgentSessionOptions({
      agent,
      sessionId,
      target: LOCAL,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      ...(selectionFromStatus ? { optionSelection: EMPTY_SELECTION } : {}),
      fence: 1,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate: async () => null,
      launch: LAUNCH
    })
    frames.push(options.optionSnapshot.map((option) => option.id))
    return options
  })
  return { ...view, frames }
}

beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

it.each(['codex', 'grok', 'pi', 'claude'])(
  '%s keeps its picker when options answer before the first listing, with either selection source',
  async (agent) => {
    for (const selectionFromStatus of [false, true]) {
      resetHostModelCatalogSnapshotsForTests()
      const listing = Promise.withResolvers<AgentSessionModelCatalogResult>()
      mocks.call.mockImplementation(
        async (_target: unknown, method: string, params: { waitForListing?: boolean }) =>
          method === 'agentSession.modelCatalog'
            ? params.waitForListing
              ? listing.promise
              : { origin: 'unknown', listingInProgress: true }
            : { models: [], modelsKnown: false, current: {}, conversationCommands: ['clear'] }
      )
      const view = renderChat(agent, selectionFromStatus)
      await waitFor(() => expect(view.result.current.conversationCommands).toEqual(['clear']))
      expect(view.frames.every((frame) => frame.includes('model'))).toBe(true)
      await act(async () => listing.resolve(LOADED))
      await waitFor(() => {
        const snapshot = view.result.current.optionSnapshot
        expect(snapshot.find((option) => option.id === 'model')?.kind).toMatchObject({
          currentValue: 'configured-model'
        })
        expect(snapshot.find((option) => option.id === 'effort')?.kind).toMatchObject({
          currentValue: 'high'
        })
      })
      view.unmount()

      mocks.call.mockImplementation(async (_target: unknown, method: string) =>
        method === 'agentSession.modelCatalog'
          ? LOADED
          : { models: MODELS, current: { model: 'configured-model', effort: 'high' } }
      )
      const second = renderChat(agent, selectionFromStatus, 'second-chat')
      expect(
        second.result.current.optionSnapshot.find((option) => option.id === 'model')?.kind
      ).toMatchObject({ currentValue: 'configured-model' })
      await waitFor(() => expect(second.result.current.rewind).toBeDefined())
      expect(second.frames.every((frame) => frame.includes('model'))).toBe(true)
      second.unmount()
    }
  }
)
