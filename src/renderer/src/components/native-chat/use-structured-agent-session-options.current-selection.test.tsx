// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), summary: vi.fn(), settings: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.settings
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
const MODELS = [
  {
    id: 'gpt-one',
    label: 'One',
    isDefault: true,
    defaultEffort: 'medium',
    efforts: EFFORTS.filter((effort) => effort.value !== 'high')
  },
  { id: 'gpt-two', label: 'Two', efforts: EFFORTS }
]
const PICK = { model: 'gpt-two', effort: 'high' }
const LOCAL = { kind: 'local' } as const

function pill(snapshot: readonly SessionOptionDescriptor[]) {
  const current = (id: string): string | null => {
    const entry = snapshot.find((option) => option.id === id)
    return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
  }
  return { model: current('model'), effort: current('effort') }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.summary.mockReset()
  mocks.settings.mockReset()
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockImplementation(async (_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? {
          origin: 'live-session',
          models: MODELS,
          fetchedAt: 1,
          listingNamesConfiguredModel: true
        }
      : {
          models: MODELS,
          current: { model: 'gpt-one', effort: 'medium' },
          conversationCommands: [{ name: '/help', description: 'Help' }],
          rewind: { supported: false, reason: 'unsupported' }
        }
  )
})

function renderSelection(options: {
  capable: boolean
  selection?: Readonly<Record<string, string>>
}) {
  const frames: ReturnType<typeof pill>[] = []
  const launch = { kind: 'new' as const, heldOptions: {}, seedOptions: PICK }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this proof makes no option mutation.
  const mutate = vi.fn() as unknown as StructuredAgentSessionMutate
  mocks.summary.mockImplementation(() =>
    options.capable ? { optionSelection: options.selection ?? PICK } : { status: 'idle' }
  )
  const initialProps: { fence: number; turnId: string | null } = { fence: 1, turnId: null }
  const view = renderHook(
    (props: { fence: number; turnId: string | null }) => {
      const current = useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target: LOCAL,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        optionSelection: mocks.summary()?.optionSelection,
        fence: props.fence,
        turnId: props.turnId,
        unloadedTurnRevisions: undefined,
        mutate,
        launch
      })
      frames.push(pill(current.optionSnapshot))
      return current
    },
    { initialProps }
  )
  return { frames, ...view }
}

it('keeps the host selection through fence, turn, and stale metadata reads', async () => {
  const view = renderSelection({ capable: true })
  await waitFor(() => expect(pill(view.result.current.optionSnapshot)).toEqual(PICK))
  const nextFrame = view.frames.length
  view.rerender({ fence: 2, turnId: 'turn-1' })
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.options', {
      sessionId: 'session-1'
    })
  )
  await waitFor(() => expect(view.result.current.conversationCommands).toHaveLength(1))
  expect(view.frames.slice(nextFrame)).toEqual(expect.arrayContaining([PICK]))
  expect(view.frames.slice(nextFrame).every((frame) => frame.model === PICK.model)).toBe(true)
  expect(view.frames.slice(nextFrame).every((frame) => frame.effort === PICK.effort)).toBe(true)
  view.unmount()
})

it('uses the existing options read when an older host omits the selection field', async () => {
  const view = renderSelection({ capable: false })
  await waitFor(() =>
    expect(pill(view.result.current.optionSnapshot)).toEqual({
      model: 'gpt-one',
      effort: 'medium'
    })
  )
  view.unmount()
})

it('admits one pending pick, including after the picker re-renders', async () => {
  mocks.summary.mockImplementation(() => ({ optionSelection: { model: 'gpt-one' } }))
  const write = deferred<{ options: Record<string, string> }>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deferred result is the setOption reply the hook reads.
  const mutate = vi.fn(() => write.promise) as unknown as StructuredAgentSessionMutate
  const view = renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'codex',
      sessionId: 'session-1',
      target: LOCAL,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      optionSelection: mocks.summary()?.optionSelection,
      fence: 1,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch: { kind: 'new', heldOptions: {} }
    })
  )
  await waitFor(() => expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-one'))
  let first!: Promise<boolean>
  let second!: Promise<boolean>
  act(() => {
    first = view.result.current.setStructuredOption('model', 'gpt-two')
    second = view.result.current.setStructuredOption('model', 'gpt-two')
  })
  await expect(second).resolves.toBe(false)
  await act(async () => {
    expect(await view.result.current.setStructuredOption('model', 'gpt-two')).toBe(false)
    write.resolve({ options: { model: 'gpt-two' } })
    await first
  })
  expect(mutate).toHaveBeenCalledOnce()
  view.unmount()
})

it('fences a late pick when the same session moves to another host', async () => {
  mocks.summary.mockImplementation(() => ({ optionSelection: { model: 'gpt-one' } }))
  const oldWrite = deferred<{ options: Record<string, string> }>()
  const newWrite = deferred<null>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each promise is a setOption reply.
  const mutate = vi
    .fn()
    .mockReturnValueOnce(oldWrite.promise)
    .mockReturnValueOnce(newWrite.promise) as unknown as StructuredAgentSessionMutate
  const launch = { kind: 'new' as const, heldOptions: {} }
  const remote = { kind: 'environment', environmentId: 'server-1' } as const
  const initialTarget: RuntimeClientTarget = LOCAL
  const view = renderHook<ReturnType<typeof useStructuredAgentSessionOptions>, RuntimeClientTarget>(
    (target: RuntimeClientTarget) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        optionSelection: mocks.summary()?.optionSelection,
        fence: 1,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate,
        launch
      }),
    { initialProps: initialTarget }
  )
  await waitFor(() => expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-one'))
  let first!: Promise<boolean>
  act(() => {
    first = view.result.current.setStructuredOption('model', 'gpt-two')
  })
  view.rerender(remote)
  await waitFor(() => expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-one'))
  let second!: Promise<boolean>
  act(() => {
    second = view.result.current.setStructuredOption('model', 'gpt-two')
  })
  expect(mutate).toHaveBeenCalledTimes(2)
  await act(async () => {
    oldWrite.resolve({ options: { model: 'gpt-two' } })
    await first
  })
  expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-two')
  await act(async () => {
    newWrite.resolve(null)
    await second
  })
  expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-one')
  view.unmount()
})
