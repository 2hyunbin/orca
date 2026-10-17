// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  summary: vi.fn(),
  settings: vi.fn(),
  hold: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.settings
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchOptionToken: () => mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { StructuredLaunchAcceptedOptions } from '@/lib/structured-agent-session-launch-options'
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
  mocks.hold.mockReset()
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

it.each([false, true])('reconciles choices (held: %s)', async (held) => {
  mocks.summary.mockImplementation(() => ({ optionSelection: { model: 'gpt-one' } }))
  const write = deferred<{ options: Record<string, string> }>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deferred result is the setOption reply the hook reads.
  const mutate = vi.fn(() => write.promise) as unknown as StructuredAgentSessionMutate
  let created = !held
  let acceptedOptions: StructuredLaunchAcceptedOptions | undefined
  mocks.hold.mockImplementation(() =>
    write.promise.then(({ options }) => ({ kind: 'accepted', options, fence: 1 }))
  )
  const view = renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'codex',
      sessionId: 'session-1',
      target: LOCAL,
      transportEnabled: created,
      isVisible: true,
      providerVisible: true,
      optionSelection: mocks.summary()?.optionSelection,
      hostOptionStamp: mocks.summary()?.stamp,
      hostPermissionMode: 'ask',
      fence: created ? 1 : null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch: { kind: 'new', heldOptions: {}, acceptedOptions }
    })
  )
  await waitFor(() => expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-one'))
  const readback = deferred<{
    models: typeof MODELS
    current: { model: string; effort: string }
  }>()
  const during = deferred<{ models: typeof MODELS; current: { model: string; effort: string } }>()
  let reads = 0
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.options'
      ? ++reads === 1
        ? during.promise
        : readback.promise
      : Promise.resolve({ models: MODELS })
  )
  let first!: Promise<boolean>
  let second!: Promise<boolean>
  act(() => {
    first = view.result.current.setStructuredOption('model', 'gpt-two')
    if (!held) {
      second = view.result.current.setStructuredOption('model', 'gpt-two')
    }
  })
  if (!held) {
    await expect(second).resolves.toBe(false)
  }
  mocks.summary.mockImplementation(() => ({
    optionSelection: { model: 'gpt-one' },
    stamp: 'during-write'
  }))
  view.rerender()
  await waitFor(() => expect(reads).toBe(1))
  await act(async () => {
    if (!held) {
      expect(await view.result.current.setStructuredOption('model', 'gpt-two')).toBe(false)
    }
    if (held) {
      acceptedOptions = { options: { model: 'gpt-two' }, fence: 1, token: mocks.hold }
    }
    created = true
    view.rerender()
    write.resolve({ options: { model: 'gpt-two' } })
    await first
  })
  expect(held ? mocks.hold : mutate).toHaveBeenCalledOnce()
  expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-two')
  expect(
    view.result.current.optionSnapshot.find((option) => option.id === 'permissionMode')?.kind
      .currentValue
  ).toBe('ask')
  await act(async () =>
    during.resolve({ models: MODELS, current: { model: 'gpt-one', effort: 'medium' } })
  )
  await waitFor(() => expect(reads).toBe(2))
  expect(pill(view.result.current.optionSnapshot).model).toBe('gpt-two')
  await act(async () =>
    readback.resolve({ models: MODELS, current: { model: 'gpt-one', effort: 'low' } })
  )
  await waitFor(() =>
    expect(pill(view.result.current.optionSnapshot)).toEqual({ model: 'gpt-one', effort: 'low' })
  )
  mocks.call.mockResolvedValue({
    models: MODELS,
    current: { model: 'gpt-one', effort: 'medium' }
  })
  mocks.summary.mockImplementation(() => ({
    optionSelection: { model: 'gpt-one' },
    stamp: 'fresh-snapshot'
  }))
  view.rerender()
  await waitFor(() => expect(pill(view.result.current.optionSnapshot).effort).toBe('medium'))
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

it('restores an unpicked chat’s observed model/effort and independent status permission', async () => {
  const mutate = vi.fn<StructuredAgentSessionMutate>()
  const selection = {}
  const view = renderHook(
    ({ mode }: { mode: string }) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'restored',
        target: LOCAL,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        optionSelection: selection,
        hostPermissionMode: mode,
        fence: 1,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate
      }),
    { initialProps: { mode: 'ask' } }
  )
  await waitFor(() =>
    expect(pill(view.result.current.optionSnapshot)).toEqual({ model: 'gpt-one', effort: 'medium' })
  )
  const permission = () =>
    view.result.current.optionSnapshot.find((option) => option.id === 'permissionMode')?.kind
      .currentValue
  expect(permission()).toBe('ask')
  expect(
    view.result.current.optionSnapshot.find((option) => option.id === 'model')?.valueSource
  ).toBe('reported')
  view.rerender({ mode: 'full-access' })
  expect(permission()).toBe('full-access')
  expect(mutate).not.toHaveBeenCalled()
  expect(mocks.settings).not.toHaveBeenCalled()
  view.unmount()
})
