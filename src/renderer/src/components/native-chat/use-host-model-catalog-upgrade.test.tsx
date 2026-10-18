// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(() => Promise.resolve({ kind: 'held' })),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import {
  readHostModelCatalogSnapshot,
  forgetHostModelCatalogSnapshots,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'

const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const UNKNOWN = { origin: 'unknown' }
const LISTING = { origin: 'unknown', listingInProgress: true }
const HOST_CATALOG = {
  origin: 'probe',
  models: [
    {
      id: 'gpt-hosted',
      label: 'GPT Hosted',
      isDefault: true,
      defaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    },
    // The launch seed's model, so the saved pick is one the host list names.
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [] }
  ],
  fetchedAt: 1_000
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here sends a pick over a fence, so mutate is never called.
const mutate = vi.fn(async () => null) as unknown as StructuredAgentSessionMutate

type Props = {
  hidden?: boolean
  attached?: boolean
  sessionId?: string
  worktree?: string
  seedOptions?: Record<string, string>
}

// A chat's waiting read outlives its mounts, so each test gets its own chat.
let sessionId = ''
let sessionCount = 0

function renderOptions(initial: Props = {}) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: props.sessionId ?? sessionId,
        target: PAIRED_TARGET,
        transportEnabled: props.attached === true,
        isVisible: !props.hidden,
        providerVisible: props.attached === true && !props.hidden,
        fence: props.attached ? 1 : null,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate,
        launch: {
          kind: 'new',
          seedOptions: props.seedOptions ?? {},
          heldOptions: {},
          ...(props.worktree ? { worktree: props.worktree } : {})
        }
      }),
    { initialProps: initial }
  )
}

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Each catalog read takes the next answer; `options` reads never settle unless given. */
function answerCatalog(
  answers: (() => Promise<unknown>)[],
  pureAnswers: (() => Promise<unknown>)[] = []
): void {
  let index = 0
  let pureIndex = 0
  mocks.call.mockImplementation(
    (_target: unknown, method: string, params: { sessionId?: string }) => {
      if (method === 'agentSession.modelCatalog' && !params.sessionId) {
        return pureAnswers[pureIndex++]?.() ?? Promise.resolve(UNKNOWN)
      }
      if (method === 'agentSession.modelCatalog') {
        const next = answers[index]
        index += 1
        return next ? next() : new Promise(() => {})
      }
      return new Promise(() => {})
    }
  )
}

function catalogReads(pure = false): unknown[] {
  return mocks.call.mock.calls
    .filter(
      ([, method, params]) =>
        method === 'agentSession.modelCatalog' && (pure ? !params.sessionId : params.sessionId)
    )
    .map(([, , params]) => params)
}

/** The picker opens and takes a pick: what a usable first frame means. */
function usable(snapshot: readonly SessionOptionDescriptor[]): boolean {
  return model(snapshot).settable && modelChoices(snapshot).length > 0
}

function model(snapshot: readonly SessionOptionDescriptor[]): SessionOptionDescriptor {
  return snapshot.find((entry) => entry.id === 'model')!
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const descriptor = model(snapshot)
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.value) : []
}

const flush = (): Promise<void> => act(async () => {})

describe('host model catalog read', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
    sessionCount += 1
    sessionId = `session-${sessionCount}`
  })

  it('reads a warm catalog once, showing the quiet placeholder only until it answers', async () => {
    const first = deferred()
    answerCatalog([() => first.promise])
    const { result, unmount } = renderOptions()
    await flush()
    // No built-in label the host's list could replace.
    expect(modelChoices(result.current.optionSnapshot)).toEqual([])
    expect(model(result.current.optionSnapshot).settable).toBe(false)
    first.resolve(HOST_CATALOG)
    await flush()
    expect(catalogReads()).toEqual([{ agent: 'codex', sessionId }])
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    const named = model(result.current.optionSnapshot)
    expect(named.kind.type === 'select' ? named.kind.currentValue : null).toBe('gpt-hosted')
    expect(named.valueSource).toBe('default')
    expect(usable(result.current.optionSnapshot)).toBe(true)
    unmount()
  })

  it('keeps cold discovery quiet until its joined listing lands', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toEqual([
      { agent: 'codex', sessionId },
      { agent: 'codex', sessionId, waitForListing: true }
    ])
    expect(usable(result.current.optionSnapshot)).toBe(false)
    expect(modelChoices(result.current.optionSnapshot)).toEqual([])

    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    expect(usable(result.current.optionSnapshot)).toBe(true)
    expect(catalogReads()).toHaveLength(2)
    unmount()
  })

  it('keeps unknown discovery quiet when the waiting read fails or times out', async () => {
    for (const failure of [
      () => Promise.resolve(UNKNOWN),
      () => Promise.reject(Object.assign(new Error('timed out'), { code: 'runtime_timeout' })),
      () => Promise.reject(Object.assign(new Error('gone'), { code: 'not_connected' }))
    ]) {
      mocks.call.mockReset()
      answerCatalog([() => Promise.resolve(LISTING), failure])
      const { result, unmount } = renderOptions()
      await flush()
      expect(catalogReads()).toHaveLength(2)
      expect(usable(result.current.optionSnapshot)).toBe(false)
      expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
      unmount()
    }
  })

  it('asks a host that reports no listing nothing more', async () => {
    answerCatalog([() => Promise.resolve(UNKNOWN)])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(1)
    expect(usable(result.current.optionSnapshot)).toBe(false)
    unmount()
  })

  it('shares completed pure workspace discovery while current rows and controls stay local', async () => {
    const live = deferred()
    const waited = deferred()
    const pure = deferred()
    const initial = deferred()
    const joiningId = `${sessionId}-joining`
    answerCatalog(
      [() => Promise.resolve(LISTING), () => waited.promise],
      [() => initial.promise, () => pure.promise]
    )
    const catalogAnswers = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation(
      (target: unknown, method: string, params: { sessionId?: string }) =>
        params.sessionId === joiningId
          ? Promise.resolve(UNKNOWN)
          : method === 'agentSession.options'
            ? live.promise
            : catalogAnswers(target, method, params)
    )
    const worktree = 'id:wt-a'
    const { result, unmount } = renderOptions({
      attached: true,
      worktree,
      seedOptions: { model: 'gpt-live' }
    })
    const joining = renderOptions({ worktree, sessionId: joiningId })
    await flush()
    live.resolve({
      models: [
        {
          ...HOST_CATALOG.models[0]!,
          id: 'gpt-live',
          label: 'GPT Live'
        }
      ],
      current: { model: 'gpt-live', effort: 'high', confirmed: ['model', 'effort'] }
    })
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(usable(result.current.optionSnapshot)).toBe(true)
    expect(modelChoices(result.current.optionSnapshot)).toEqual([
      'gpt-hosted',
      'gpt-5.5',
      'gpt-live'
    ])
    expect(result.current.optionSnapshot.find((entry) => entry.id === 'effort')).toMatchObject({
      settable: true,
      kind: {
        currentValue: 'high',
        choices: HOST_CATALOG.models[0]!.efforts
      }
    })
    const launch = { newLaunch: true, seedsModel: false, worktree }
    expect(readHostModelCatalogSnapshot(PAIRED_TARGET, 'codex', launch)).toBeUndefined()
    // B's answer would complete before A's delayed initial answer if it had its own request.
    pure.resolve({ ...HOST_CATALOG, listingNamesConfiguredModel: true })
    await flush()
    initial.resolve(LISTING)
    await waitFor(() => expect(catalogReads(true)).toHaveLength(2), { timeout: 2_000 })
    await flush()
    expect(catalogReads(true)).toEqual([
      { agent: 'codex', worktree },
      { agent: 'codex', worktree, waitForListing: true }
    ])
    const shared = readHostModelCatalogSnapshot(PAIRED_TARGET, 'codex', launch)
    expect(shared?.origin !== 'unknown' && shared?.models.map((row) => row.id)).toEqual([
      'gpt-hosted',
      'gpt-5.5'
    ])
    const next = renderOptions({ worktree, sessionId: `${sessionId}-next` })
    expect(model(next.result.current.optionSnapshot)).toMatchObject({
      kind: { currentValue: 'gpt-hosted' }
    })
    expect(next.result.current.optionSnapshot.find((entry) => entry.id === 'effort')).toMatchObject(
      {
        kind: { currentValue: 'high' }
      }
    )
    expect(modelChoices(next.result.current.optionSnapshot)).not.toContain('gpt-live')
    next.unmount()
    const other = renderOptions({ worktree: 'id:wt-b', sessionId: `${sessionId}-other` })
    expect(usable(other.result.current.optionSnapshot)).toBe(false)
    other.unmount()
    joining.unmount()
    unmount()
  })

  it('discards the pre-attach wait when a new process generation starts', async () => {
    const waited = deferred()
    const attached = deferred()
    const oldAccount = deferred()
    const freshAccount = deferred()
    answerCatalog(
      [() => Promise.resolve(LISTING), () => waited.promise, () => attached.promise],
      [() => Promise.resolve(LISTING), () => oldAccount.promise, () => freshAccount.promise]
    )
    const worktree = 'id:wt-account'
    const { result, rerender, unmount } = renderOptions({ worktree })
    await waitFor(() => expect(catalogReads(true)).toHaveLength(2), { timeout: 2_000 })
    forgetHostModelCatalogSnapshots(PAIRED_TARGET)
    rerender({ attached: true, worktree })
    await flush()
    expect(catalogReads()).toHaveLength(3)
    waited.resolve(HOST_CATALOG)
    oldAccount.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    const launch = { newLaunch: true, seedsModel: true, worktree }
    expect(readHostModelCatalogSnapshot(PAIRED_TARGET, 'codex', launch)).toBeUndefined()
    freshAccount.resolve({ ...HOST_CATALOG, models: [HOST_CATALOG.models[1]!] })
    attached.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    const shared = readHostModelCatalogSnapshot(PAIRED_TARGET, 'codex', launch)
    expect(shared?.origin !== 'unknown' && shared?.models.map((row) => row.id)).toEqual(['gpt-5.5'])
    unmount()
  })

  it('joins the wait already in flight when the pane hides and shows again', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ hidden: true })
    await flush()
    rerender({})
    await flush()
    expect(catalogReads()).toHaveLength(2)
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    unmount()
  })

  it('joins the wait already in flight when the chat mounts again', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const first = renderOptions()
    await flush()
    first.unmount()
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(2)
    expect(usable(result.current.optionSnapshot)).toBe(false)
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    unmount()
  })

  it('answers only the chat whose host is listing', async () => {
    const waited = deferred()
    answerCatalog([
      () => Promise.resolve(LISTING),
      () => waited.promise,
      () => Promise.resolve(UNKNOWN)
    ])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ sessionId: `${sessionId}-other` })
    await flush()
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    expect(catalogReads()).toHaveLength(3)
    unmount()
  })

  it.each([false, true])('keeps no late pure answer after close (joined=%s)', async (joined) => {
    const waited = deferred()
    const pure = deferred()
    answerCatalog(
      [() => Promise.resolve(LISTING), () => waited.promise, () => Promise.resolve(UNKNOWN)],
      joined ? [() => Promise.resolve(LISTING), () => pure.promise] : [() => pure.promise]
    )
    const first = renderOptions()
    await flush()
    if (joined) {
      await waitFor(() => expect(catalogReads(true)).toHaveLength(2), { timeout: 2_000 })
    }
    first.unmount()
    waited.resolve(HOST_CATALOG)
    pure.resolve(HOST_CATALOG)
    await flush()
    expect(
      readHostModelCatalogSnapshot(PAIRED_TARGET, 'codex', {
        newLaunch: true,
        seedsModel: true
      })
    ).toBeUndefined()
    // A later open of the same chat asks afresh instead of joining a finished wait.
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(3)
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    unmount()
  })
})
