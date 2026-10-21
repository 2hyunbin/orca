// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  preloadHostModelCatalogSnapshots,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

import { structuredAgentSessionSendSelection } from '../../../../shared/structured-agent-session-option-view'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

type Listed = Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }>

function listed(
  models: { id: string; label: string }[],
  listingNamesConfiguredModel = false
): Listed {
  return {
    origin: 'probe',
    models: models.map((model, index) => ({
      ...model,
      isDefault: index === 0,
      defaultEffort: 'high',
      efforts: EFFORTS
    })),
    fetchedAt: 1_000,
    listingNamesConfiguredModel
  }
}

const CLAUDE_LIST = listed([
  { id: 'opus[1m]', label: 'Opus (1M context)' },
  { id: 'sonnet', label: 'Sonnet' }
])
// Labels the built-in list does not use, so a frame painted from it is told apart.
const CODEX_LIST = listed([
  { id: 'gpt-5.5', label: 'GPT-5.5 (host)' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }
])
const GROK_LIST = listed([{ id: 'grok-build', label: 'Grok Build' }], true)

type Pill = { model: string | null; label: string | null; effort: string | null; usable: boolean }

function pill(snapshot: readonly SessionOptionDescriptor[]): Pill {
  const model = snapshot.find((entry) => entry.id === 'model')
  const effort = snapshot.find((entry) => entry.id === 'effort')
  const current = model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null
  const choice =
    model?.kind.type === 'select'
      ? model.kind.choices.find((entry) => entry.value === current)
      : undefined
  return {
    model: current,
    label: choice?.label ?? null,
    effort: effort?.kind.type === 'select' ? (effort.kind.currentValue ?? null) : null,
    usable: Boolean(model?.settable)
  }
}

const PLACEHOLDER: Pill = { model: null, label: null, effort: null, usable: false }

/** Every frame the pane rendered, in order. */
function renderNewChat(args: {
  agent: AgentType
  target?: RuntimeClientTarget
  seedOptions?: Record<string, string>
  sessionId?: string
}) {
  const frames: Pill[] = []
  const view = renderHook(() => {
    const options = useStructuredAgentSessionOptions({
      agent: args.agent,
      sessionId: args.sessionId ?? 'session-1',
      target: args.target ?? LOCAL_TARGET,
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no pick is made, so mutate is never called.
      mutate: vi.fn() as unknown as StructuredAgentSessionMutate,
      launch: {
        kind: 'new',
        heldOptions: {},
        worktree: 'id:wt-1',
        ...(args.seedOptions ? { seedOptions: args.seedOptions } : {})
      }
    })
    frames.push(pill(options.optionSnapshot))
    return options
  })
  return { frames, ...view }
}

function catalogAnswers(...answers: (() => Promise<unknown>)[]): void {
  let reads = 0
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? (answers[Math.min(reads++, answers.length - 1)] ?? (() => new Promise(() => {})))()
      : new Promise(() => {})
  )
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

describe('a new chat picker’s first frame', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('names a saved Claude pick and its effort from the saved list on the first frame', async () => {
    catalogAnswers(() => Promise.resolve(CLAUDE_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['claude'])
    const { frames, unmount } = renderNewChat({
      agent: 'claude',
      seedOptions: { model: 'opus[1m]', effort: 'high' }
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const final = { model: 'opus[1m]', label: 'Opus (1M context)', effort: 'high', usable: true }
    expect(frames[0]).toEqual(final)
    // The pane's own read lands the same list: no frame ever showed anything else.
    expect(frames.every((frame) => JSON.stringify(frame) === JSON.stringify(final))).toBe(true)
    unmount()
  })

  it('retains child-only effort slots disabled across a fence and inventory reply', async () => {
    const replacement = deferred<unknown>()
    const inventory = deferred<unknown>()
    let fence = 1
    const child: AgentSessionOptionsResult = {
      models: [{ id: 'A', label: 'A', isDefault: false, efforts: EFFORTS }],
      current: { model: 'A', effort: 'high', permissionMode: 'ask', defaulted: [] }
    }
    let raw = listed([{ id: 'A', label: 'A' }])
    let optionsAnswer = () => Promise.resolve(child)
    let followed = deferred<AgentSessionModelCatalogResult>()
    mocks.call.mockImplementation(
      (_target: unknown, method: string, params: { waitForListing?: boolean }) =>
        method === 'agentSession.options'
          ? fence === 1
            ? optionsAnswer()
            : replacement.promise
          : method === 'agentSession.modelCatalog'
            ? fence === 1
              ? params.waitForListing
                ? followed.promise
                : Promise.resolve(raw)
              : inventory.promise
            : new Promise(() => {})
    )
    const writes = vi.fn().mockResolvedValue(null)
    const mutate: StructuredAgentSessionMutate = writes
    const effortFrames: (boolean | undefined)[] = []
    const view = renderHook(
      ({ currentFence }) => {
        const options = useStructuredAgentSessionOptions({
          agent: 'codex',
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          fence: currentFence,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate
        })
        effortFrames.push(options.optionSnapshot.find((row) => row.id === 'effort')?.settable)
        return options
      },
      { initialProps: { currentFence: 1 } }
    )
    const effort = () => view.result.current.optionSnapshot.find((row) => row.id === 'effort')
    await waitFor(() => expect(effort()?.settable).toBe(true))
    const reads = () =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length
    const catalogs = () =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog').length
    const demand = () => act(async () => view.result.current.optionSurface.demandModelCatalog?.())
    const baselineReads = reads()
    const baselineCatalogs = catalogs()
    const beforeUnchanged = effortFrames.length
    raw = { ...raw, origin: 'live-session', fetchedAt: 2_000 }
    await demand()
    expect(effort()?.settable).toBe(true)
    expect(reads()).toBe(baselineReads)
    expect(catalogs()).toBe(baselineCatalogs + 1)
    expect(effortFrames.slice(beforeUnchanged).every((settable) => settable === true)).toBe(true)
    const staleSetter = view.result.current.setStructuredOption
    const oldReadback = deferred<AgentSessionOptionsResult>()
    optionsAnswer = () => oldReadback.promise
    await act(async () => {
      await staleSetter('permissionMode', 'full-access')
    })
    const currentRead = deferred<AgentSessionOptionsResult>()
    optionsAnswer = () => currentRead.promise
    raw = { ...raw, models: raw.models.map((row) => ({ ...row, efforts: [EFFORTS[1]!] })) }
    await demand()
    expect(effort()).toMatchObject({ settable: false, kind: { currentValue: 'high' } })
    expect(await staleSetter('effort', 'low')).toBe(false)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(view.result.current.optionSnapshot.find((row) => row.id === 'model')?.settable).toBe(
      true
    )
    expect(
      view.result.current.optionSnapshot.find((row) => row.id === 'permissionMode')?.settable
    ).toBe(true)
    expect(
      structuredAgentSessionSendSelection(view.result.current.sendSource.optionStateRef.current)
    ).toBeUndefined()
    expect(view.result.current.sendSource.optionStateRef.current.record.values).toMatchObject({
      model: { value: 'A' },
      effort: { value: 'high' }
    })
    const refusedSurface = await view.result.current.optionSurface.setOption('effort', 'low')
    expect(refusedSurface.snapshot.find((row) => row.id === 'effort')?.settable).toBe(false)
    // A refused model write still releases current reconciliation behind the stale readback.
    await act(async () => {
      expect(await staleSetter('model', 'A')).toBe(false)
    })
    await act(async () => oldReadback.resolve(child))
    expect(effort()?.settable).toBe(false)
    expect(reads()).toBe(baselineReads + 2)
    const highOnly = { ...child, models: raw.models }
    await act(async () => currentRead.resolve(highOnly))
    expect(effort()).toBeUndefined()
    expect(await staleSetter('effort', 'low')).toBe(false)
    expect(view.result.current.sendSource.optionStateRef.current.record.values.effort?.value).toBe(
      'high'
    )
    const childRead = deferred<AgentSessionOptionsResult>()
    optionsAnswer = () => childRead.promise
    raw = { ...listed([{ id: 'B', label: 'B' }]), listingInProgress: true }
    await demand()
    expect(effort()).toBeUndefined()
    await act(async () => childRead.resolve(child))
    expect(effort()?.settable).toBe(true)
    writes.mockResolvedValueOnce({
      key: 'effort',
      value: 'low',
      options: { model: 'A', effort: 'low' }
    })
    optionsAnswer = () =>
      Promise.resolve({ ...child, current: { ...child.current, effort: 'low' } })
    await act(async () => {
      expect(await view.result.current.setStructuredOption('effort', 'low')).toBe(true)
    })
    expect(writes).toHaveBeenLastCalledWith('agentSession.setOption', 'agentSession.setOption', {
      key: 'effort',
      value: 'low'
    })
    writes.mockResolvedValueOnce({
      key: 'effort',
      value: 'high',
      options: { model: 'A', effort: 'high' }
    })
    optionsAnswer = () => Promise.resolve(child)
    await act(async () => {
      await view.result.current.setStructuredOption('effort', 'high')
    })
    const beforeFollow = reads()
    const beforeCatalogs = catalogs()
    // Identical progress carries no new dependency and schedules no repeated options work.
    vi.useFakeTimers()
    const firstFollow = followed
    followed = deferred<AgentSessionModelCatalogResult>()
    await act(async () => {
      firstFollow.resolve(raw)
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(reads()).toBe(beforeFollow)
    expect(effort()?.settable).toBe(true)
    raw = { ...raw, listingInProgress: undefined }
    await act(async () => followed.resolve(raw))
    expect(reads()).toBe(beforeFollow + 1)
    expect(effort()?.settable).toBe(true)
    expect(catalogs()).toBe(beforeCatalogs + 1)
    vi.useRealTimers()
    await demand()
    expect(reads()).toBe(beforeFollow + 1)
    expect(effort()?.settable).toBe(true)
    writes.mockClear()
    fence = 2
    view.rerender({ currentFence: 2 })
    expect(effort()).toMatchObject({ settable: false, kind: { currentValue: 'high' } })
    await act(async () => inventory.resolve(CODEX_LIST))
    expect(effort()).toMatchObject({ settable: false, kind: { currentValue: 'high' } })
    expect(await view.result.current.setStructuredOption('effort', 'low')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    await act(async () => replacement.resolve(child))
    await waitFor(() => expect(effort()?.settable).toBe(true))
    view.unmount()
  })

  it('codex: the saved list names a saved pick and its effort on the first frame', async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['codex'])
    const { frames, unmount } = renderNewChat({
      agent: 'codex',
      seedOptions: { model: 'gpt-5.5', effort: 'low' }
    })
    expect(frames[0]).toEqual({
      model: 'gpt-5.5',
      label: 'GPT-5.5 (host)',
      effort: 'low',
      usable: true
    })
    unmount()
  })

  it('grok: the default the host names for a workspace is named on that workspace’s next chat', async () => {
    catalogAnswers(() => Promise.resolve(GROK_LIST))
    const first = renderNewChat({ agent: 'grok' })
    await waitFor(() => expect(first.frames.at(-1)?.label).toBe('Grok Build'))
    first.unmount()
    const next = renderNewChat({ agent: 'grok', sessionId: 'session-2' })
    expect(next.frames[0]).toEqual({
      model: 'grok-build',
      label: 'Grok Build',
      effort: 'high',
      usable: true
    })
    next.unmount()
  })

  it('a chat naming no model waits for its own workspace’s answer: its config may replace the default', async () => {
    catalogAnswers(() => Promise.resolve(GROK_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['grok'])
    const { frames, unmount } = renderNewChat({ agent: 'grok' })
    expect(frames[0]).toEqual(PLACEHOLDER)
    await waitFor(() => expect(frames.at(-1)?.label).toBe('Grok Build'))
    expect(frames.filter((frame) => frame.model === null).every((f) => !f.usable)).toBe(true)
    unmount()
  })

  it.each(['claude', 'codex', 'grok'] as const)(
    '%s: a cold account shows the quiet placeholder until the host answers, then the list once',
    async (agent) => {
      const answer = deferred<AgentSessionModelCatalogResult>()
      catalogAnswers(() => answer.promise)
      const list = agent === 'claude' ? CLAUDE_LIST : agent === 'codex' ? CODEX_LIST : GROK_LIST
      const first = list.models[0]!
      const { frames, unmount } = renderNewChat({ agent, seedOptions: { model: first.id } })
      expect(frames[0]).toEqual(PLACEHOLDER)
      answer.resolve(list)
      await waitFor(() => expect(frames.at(-1)?.usable).toBe(true))
      const named = frames.filter((frame) => frame.model !== null)
      // Only the host's label is ever painted: no built-in label, no raw id, no second change.
      expect(new Set(named.map((frame) => frame.label))).toEqual(new Set([first.label]))
      const beforeNamed = frames.slice(0, frames.indexOf(named[0]!))
      expect(beforeNamed).toEqual(beforeNamed.map(() => PLACEHOLDER))
      unmount()
    }
  )

  it('with nothing saved, the built-in list is usable, naming nothing, until the listing lands', async () => {
    const listing = deferred<AgentSessionModelCatalogResult>()
    catalogAnswers(
      () => Promise.resolve({ origin: 'unknown', listingInProgress: true }),
      () => listing.promise
    )
    const { frames, unmount } = renderNewChat({ agent: 'codex', seedOptions: { model: 'gpt-5.5' } })
    expect(frames[0]).toEqual(PLACEHOLDER)
    await waitFor(() => expect(frames.at(-1)).toEqual({ ...PLACEHOLDER, usable: true }))
    listing.resolve(CODEX_LIST)
    await waitFor(() => expect(frames.at(-1)?.label).toBe('GPT-5.5 (host)'))
    expect(frames.some((frame) => frame.model !== null && frame.label !== 'GPT-5.5 (host)')).toBe(
      false
    )
    unmount()
  })

  it('never paints a saved pick the host list does not name', async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['codex'])
    const { frames, unmount } = renderNewChat({
      agent: 'codex',
      seedOptions: { model: 'gpt-retired' }
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(frames.every((frame) => frame.model === null && !frame.usable)).toBe(true)
    unmount()
  })

  it("uses a paired server's own saved list, kept from its last new chat", async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    const first = renderNewChat({
      agent: 'codex',
      target: PAIRED_TARGET,
      seedOptions: { model: 'gpt-5.5' }
    })
    await waitFor(() => expect(first.frames.at(-1)?.label).toBe('GPT-5.5 (host)'))
    first.unmount()

    const second = renderNewChat({
      agent: 'codex',
      target: PAIRED_TARGET,
      seedOptions: { model: 'gpt-6.1-sol' },
      sessionId: 'session-2'
    })
    expect(second.frames[0]).toMatchObject({ label: 'GPT-6.1 Sol', usable: true })
    second.unmount()
    // This machine's host never answered, so its chat waits for it rather than borrow the server's.
    const local = renderNewChat({ agent: 'codex', seedOptions: { model: 'gpt-5.5' } })
    expect(local.frames[0]).toEqual(PLACEHOLDER)
    local.unmount()
  })
})
