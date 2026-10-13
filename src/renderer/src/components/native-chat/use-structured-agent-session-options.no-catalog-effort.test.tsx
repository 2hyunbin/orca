// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL = { kind: 'local' } as const
const LAUNCH = { kind: 'new' as const, heldOptions: {}, worktree: 'folder:one' }

function selection(snapshot: readonly SessionOptionDescriptor[]) {
  const value = (id: string) => {
    const option = snapshot.find((entry) => entry.id === id)
    return option?.kind.type === 'select' ? option.kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

it.each([
  ['claude', 'opus'],
  ['codex', 'gpt-5.5']
])('%s keeps a saved effort through start before its catalog loads', async (agent, model) => {
  for (const selectionFromStatus of [false, true]) {
    resetHostModelCatalogSnapshotsForTests()
    const saved = { model, effort: 'high' }
    const listing = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.modelCatalog'
        ? listing.promise
        : { models: [], modelsKnown: false, current: saved, conversationCommands: ['clear'] }
    )
    const frames: ReturnType<typeof selection>[] = []
    const view = renderHook(
      ({ fence, starting }: { fence: number; starting: boolean }) => {
        const options = useStructuredAgentSessionOptions({
          agent,
          sessionId: 'saved-chat',
          target: LOCAL,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          providerStarting: starting,
          ...(selectionFromStatus ? { optionSelection: saved } : {}),
          fence,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate: async () => null,
          launch: LAUNCH
        })
        frames.push(selection(options.optionSnapshot))
        return options
      },
      { initialProps: { fence: 1, starting: false } }
    )
    await waitFor(() => expect(view.result.current.conversationCommands).toEqual(['clear']))
    expect(selection(view.result.current.optionSnapshot)).toEqual(saved)
    const beforeStart = frames.length
    view.rerender({ fence: 2, starting: true })
    expect(selection(view.result.current.optionSnapshot)).toEqual(saved)
    view.rerender({ fence: 2, starting: false })
    await waitFor(() => expect(view.result.current.rewind).toBeDefined())
    expect(
      frames.slice(beforeStart).every((frame) => frame.model === model && frame.effort === 'high')
    ).toBe(true)
    await act(async () =>
      listing.resolve({
        origin: 'probe',
        models: [
          {
            id: model,
            label: 'Host model',
            isDefault: false,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        fetchedAt: 1
      })
    )
    await waitFor(() =>
      expect(
        view.result.current.optionSnapshot.find((option) => option.id === 'model')?.kind
      ).toMatchObject({ choices: [{ value: model, label: 'Host model' }] })
    )
    expect(selection(view.result.current.optionSnapshot)).toEqual(saved)
    view.unmount()
  }
})
