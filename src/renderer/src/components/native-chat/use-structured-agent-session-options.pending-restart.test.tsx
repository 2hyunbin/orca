// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), settings: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.settings
}))

import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL = { kind: 'local' } as const
const LAUNCH = { kind: 'new' as const, heldOptions: {} }
const SELECTION = { model: 'gpt-one' }
const MODELS = ['gpt-one', 'gpt-two'].map((id) => ({ id, label: id, efforts: [] }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  mocks.settings.mockReset()
  mocks.call.mockImplementation(async (_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? { origin: 'live-session', models: MODELS, fetchedAt: 1 }
      : { models: MODELS, current: {} }
  )
})

it.each([false, true])(
  'admits a later pick after restart when the earlier reply %s arrives',
  async (settlesLate) => {
    const abandoned = deferred<{ options: Record<string, string> }>()
    const latest = deferred<null>()
    const send = vi.fn().mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(latest.promise)
    const mutate: StructuredAgentSessionMutate = send
    const initialFence: number | null = 1
    const view = renderHook<ReturnType<typeof useStructuredAgentSessionOptions>, number | null>(
      (fence: number | null) =>
        useStructuredAgentSessionOptions({
          agent: 'codex',
          sessionId: 'session-1',
          target: LOCAL,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          optionSelection: SELECTION,
          fence,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate,
          launch: LAUNCH
        }),
      { initialProps: initialFence }
    )
    await waitFor(() => expect(view.result.current.rewind).toBeDefined())
    let first!: Promise<boolean>
    act(() => {
      first = view.result.current.setStructuredOption('model', 'gpt-two')
    })
    expect(send).toHaveBeenCalledOnce()
    view.rerender(null)
    view.rerender(2)
    let second!: Promise<boolean>
    act(() => {
      second = view.result.current.setStructuredOption('model', 'gpt-two')
    })
    expect(send).toHaveBeenCalledTimes(2)
    if (settlesLate) {
      await act(async () => {
        abandoned.resolve({ options: { model: 'gpt-two' } })
        expect(await first).toBe(false)
      })
      expect(mocks.settings).not.toHaveBeenCalled()
      await act(async () => {
        expect(await view.result.current.setStructuredOption('model', 'gpt-one')).toBe(false)
      })
      expect(send).toHaveBeenCalledTimes(2)
    }
    await act(async () => {
      latest.resolve(null)
      expect(await second).toBe(false)
    })
    const model = view.result.current.optionSnapshot.find((option) => option.id === 'model')
    expect(model?.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-one')
    view.unmount()
  }
)
