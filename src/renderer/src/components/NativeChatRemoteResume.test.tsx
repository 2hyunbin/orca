// @vitest-environment happy-dom
import { act } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import {
  useNativeChatTargetRestartResuming,
  useNativeChatRestartRuntimes
} from './native-chat-restart-runtimes'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { resumeRunView } from './native-chat-resume-run-view'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  requestNativeChatResumeOnRestartDialog,
  getNativeChatResumeOnRestartDialogRequest
} from './native-chat-resume-on-restart-dialog'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createResumeModalFixture,
  offered,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { NativeChatResumeRuntimeModal } from './NativeChatResumeOnRestartModal'
import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'

const rpc = vi.hoisted(() => vi.fn<RestartRpc>())
const stream: ResumeStatusStream = vi.hoisted(() => ({ emit: () => {}, snapshot: new Map() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    stream.emit = emit
    emit({ type: 'snapshot', sessions: [] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)
const { mount, button } = createResumeModalFixture(rpc, stream)
const stores: NativeChatRestartStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store._resetNativeChatRestartOffer()
    store.consumeNativeChatResumeOnRestartDialogRequest()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function store() {
  const value = createNativeChatRestartStore({ kind: 'environment', environmentId: 'ssh' })
  stores.push(value)
  vi.stubGlobal('api', { runtimeEnvironments: { desktopCreatedChatIds: async () => ['a'] } })
  return value
}
function ready(runtimeId: string): RuntimeEnvironmentStatus {
  return {
    checkedAt: 0,
    status: {
      runtimeId,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
  }
}

it.each([
  ['Resume 1 chat started here', ['a']],
  ['Resume all 2 on Server', ['a', 'b']]
])(
  'sends the server offer chosen by %s, including a chat from another client',
  async (label, ids) => {
    const remote = store()
    rpc.mockResolvedValue({ sessions: offered })
    await act(async () => remote.observeRuntimeStatus(ready('first')))
    await mount(<NativeChatResumeRuntimeModal store={remote} machineName="Server" offerEnabled />)
    expect(document.body.textContent).toContain('Resume chats on Server?')
    expect(document.body.textContent).not.toContain("Don't ask again")
    rpc.mockResolvedValue({ sessions: [offered[1]], failed: [failure('a')] })
    await act(async () => button(String(label)).click())
    expect(rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'ssh' },
      'agentSession.restartContinue',
      { sessionIds: ids },
      { beforeSend: expect.any(Function) }
    )
    expect(remote.startedHere(remote.getNativeChatRestartOffer().failed[0].sessionId)).toBe(true)
    expect(remote.startedHere(remote.getNativeChatRestartOffer().candidates[0].sessionId)).toBe(
      false
    )
  }
)

it('snoozes server failures locally through reconnect and reopens for a new runtime', async () => {
  const remote = store()
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus(ready('first')))
  await remote.dismissNativeChatRestartOffer(['a'])
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(remote.getNativeChatRestartOffer().candidates).toHaveLength(2)
  remote.observeRuntimeStatus(undefined)
  await act(async () => remote.observeRuntimeStatus(ready('first')))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(false)
  await act(async () => remote.observeRuntimeStatus(ready('second')))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(true)
})

it.each([undefined, { sessions: [] }])(
  'shows no remote dialog when an older server has no offers: %s',
  async (answer) => {
    const remote = store()
    if (answer) {
      rpc.mockResolvedValue(answer)
    } else {
      rpc.mockRejectedValue(
        new RuntimeRpcCallError({
          id: 'list',
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method' }
        })
      )
    }
    await act(async () => remote.observeRuntimeStatus(ready('old')))
    expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    expect(remote.getNativeChatRestartOffer().candidates).toEqual([])
  }
)

it('replaces unseen run history coherently at the next runtime and retires late work', async () => {
  const remote = store()
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus(ready('r1')))
  rpc.mockResolvedValue({ sessions: [], continued: [{ sessionId: 'a', outcome: 'continued' }] })
  await act(async () => remote.continueNativeChatRestartOffer(['a']))
  expect(remote.getNativeChatRestartRun()?.continued).toEqual([
    { sessionId: 'a', outcome: 'continued' }
  ])
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus(ready('r2')))
  expect(remote.getNativeChatRestartRun()).toBeNull()
  await mount(<NativeChatResumeRuntimeModal store={remote} machineName="Server" offerEnabled />)
  expect(button('Resume 1 chat started here').disabled).toBe(false)
  const old = remote.getNativeChatRestartOccurrence()
  const pending = Promise.withResolvers<unknown>()
  rpc.mockReturnValueOnce(pending.promise)
  const action = remote.continueNativeChatRestartOffer(['a'])
  await act(async () => remote.observeRuntimeStatus(ready('r3')))
  const snapshot = remote.getNativeChatRestartOffer()
  await act(async () => {
    pending.resolve({ sessions: [] })
    await action
    await old.reopenNativeChatRestartOffer()
  })
  expect(remote.getNativeChatRestartOffer()).toBe(snapshot)
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  expect(remote.getNativeChatRestartRun()).toBeNull()
})

it('disposes pending discovery without resurrecting subscriptions or blocking another dialog', async () => {
  const remote = store()
  const pending = Promise.withResolvers<unknown>()
  rpc.mockReturnValueOnce(pending.promise)
  remote.observeRuntimeStatus(ready('r1'))
  remote.dispose()
  requestNativeChatResumeOnRestartDialog()
  await act(async () => pending.resolve({ sessions: offered }))
  expect(remote.getNativeChatRestartOffer().candidates).toEqual([])
  expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('retries unsettled discovery finitely, keeps empty owners history-free and hydrates nonempty offers', async () => {
  vi.useFakeTimers()
  const remote = store()
  const history = vi.fn(async () => ['a'])
  vi.stubGlobal('api', { runtimeEnvironments: { desktopCreatedChatIds: history } })
  rpc
    .mockRejectedValueOnce(new Error('temporarily offline'))
    .mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus(ready('r0')))
  await act(async () => vi.advanceTimersByTimeAsync(100))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  expect(rpc).toHaveBeenCalledTimes(2)
  rpc.mockReset()
  history.mockClear()
  rpc.mockRejectedValue(new Error('temporarily offline'))
  await act(async () => remote.observeRuntimeStatus(ready('r1')))
  await act(async () => vi.advanceTimersByTimeAsync(850))
  expect(rpc).toHaveBeenCalledTimes(4)
  expect(history).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(rpc).toHaveBeenCalledTimes(4)
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.observeRuntimeStatus({ ...ready('r1'), hostContactEpoch: 1 }))
  expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  expect(history).toHaveBeenCalledTimes(1)
  await act(async () => remote.refreshNativeChatRestartOffer())
  expect(history).toHaveBeenCalledTimes(1)
  rpc.mockResolvedValue({ sessions: [] })
  await act(async () => remote.refreshNativeChatRestartOffer())
  expect(remote.startedHere('a')).toBe(false)
  rpc.mockResolvedValue({ sessions: offered })
  await act(async () => remote.refreshNativeChatRestartOffer())
  expect(history).toHaveBeenCalledTimes(2)
  rpc.mockRejectedValue(new Error('offline'))
  await act(async () => remote.observeRuntimeStatus(ready('r2')))
  const calls = rpc.mock.calls.length
  remote.dispose()
  await act(async () => vi.advanceTimersByTimeAsync(850))
  expect(rpc).toHaveBeenCalledTimes(calls)
})

it.each(['here', 'all'])(
  'chunks the complete filtered %s choice into one action and notification',
  async (scope) => {
    const remote = store()
    const many = Array.from({ length: 513 }, (_, i) => ({ ...offered[0], sessionId: `mine-${i}` }))
    const retry = { ...failure('a', 'agent_session_conflict'), sessionId: 'retry' }
    const excluded = {
      ...failure('a', 'structured_agent_session_unsupported'),
      sessionId: 'excluded',
      retryable: false
    }
    const manual = { ...failure('a'), sessionId: 'manual' }
    let remaining = [...many, offered[1]]
    let failures = [retry, excluded, manual]
    vi.stubGlobal('api', {
      runtimeEnvironments: {
        desktopCreatedChatIds: async () => [...many.map((row) => row.sessionId), 'retry']
      }
    })
    rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.restartResumable') {
        return { sessions: remaining, failed: failures }
      }
      const ids = params?.sessionIds ?? []
      remaining = remaining.filter((row) => !ids.includes(row.sessionId))
      failures = failures.filter((row) => !ids.includes(row.sessionId))
      return {
        sessions: remaining,
        failed: failures,
        continued: ids.map((sessionId) => ({ sessionId, outcome: 'continued' }))
      }
    })
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    await mount(<NativeChatResumeRuntimeModal store={remote} machineName="Server" offerEnabled />)
    expect(document.querySelector('button[aria-label^="Dismiss "]')).toBeNull()
    expect(
      [...document.querySelectorAll('button')].filter(
        (entry) => entry.textContent?.trim() === 'Dismiss'
      )
    ).toHaveLength(1)
    await act(async () =>
      button(
        scope === 'here' ? 'Resume 514 chats started here' : 'Resume all 515 on Server'
      ).click()
    )
    const chunks = rpc.mock.calls
      .filter((call) => call[1] === 'agentSession.restartContinue')
      .map((call) => call[2]?.sessionIds ?? [])
    expect(chunks.map((chunk) => chunk.length)).toEqual([512, scope === 'here' ? 2 : 3])
    expect(chunks.flat()).toEqual([
      ...many.map((row) => row.sessionId),
      ...(scope === 'all' ? ['b'] : []),
      'retry'
    ])
    expect(remote.getNativeChatRestartRun()?.continued).toHaveLength(scope === 'here' ? 514 : 515)
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)
  }
)

it.each(['available', 'unavailable', 'no-tail', 'retired'])(
  'keeps accepted-but-lost outcomes and untouched choices distinct (%s)',
  async (mode) => {
    const remote = store()
    const many = Array.from({ length: mode === 'no-tail' ? 1024 : 1025 }, (_, i) => ({
      ...offered[0],
      sessionId: `chat-${i}`
    }))
    let remaining = many
    let chunks = 0
    let failedRead = false
    const pending = Promise.withResolvers<unknown>()
    rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.restartResumable') {
        if (failedRead) {
          throw new Error('reconciliation unavailable')
        }
        return { sessions: remaining, failed: [] }
      }
      const ids = params?.sessionIds ?? []
      remaining = remaining.filter((row) => !ids.includes(row.sessionId))
      if (++chunks === 2) {
        return pending.promise
      }
      return {
        sessions: remaining,
        failed: [],
        continued: ids.map((sessionId) => ({ sessionId, outcome: 'continued' }))
      }
    })
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    let action: Promise<void>
    await act(async () => {
      action = remote.continueNativeChatRestartOffer(many.map((row) => row.sessionId))
    })
    expect(chunks).toBe(2)
    await act(async () => {
      if (mode === 'retired') {
        remote.dispose()
      }
      failedRead = mode === 'unavailable'
      pending.reject(new Error('accepted reply lost'))
      await action!
    })
    expect(chunks).toBe(2)
    if (mode === 'retired') {
      expect(vi.mocked(toast)).not.toHaveBeenCalled()
      return
    }
    const run = remote.getNativeChatRestartRun()!
    expect(run.entries).toHaveLength(1024)
    expect(run.continued?.filter((row) => row.outcome === 'continued')).toHaveLength(512)
    expect(run.continued?.filter((row) => row.outcome === 'unknown')).toHaveLength(512)
    const view = resumeRunView(
      run,
      remote.getNativeChatRestartOffer().candidates,
      () => undefined,
      'all'
    )
    expect(view.counts).toMatchObject({ resumed: 512, attention: 512 })
    expect(vi.mocked(toast).mock.calls).toEqual([
      [
        'Couldn’t confirm 512 chats were resumed',
        expect.objectContaining({
          description: 'Resumed 512 chats',
          action: expect.objectContaining({ label: 'Review' })
        })
      ]
    ])
    await mount(<NativeChatResumeRuntimeModal store={remote} machineName="Server" offerEnabled />)
    await act(async () => remote.reopenNativeChatRestartOffer())
    if (mode === 'no-tail') {
      // This run-only unknown also uses the existing lasting status/check presentation.
      expect(remote.getNativeChatRestartOffer()).toMatchObject({ candidates: [], failed: [] })
      expect(view.statusBySession.get('chat-512')?.kind).toBe('unconfirmed')
      expect(document.body.textContent).toContain('Open the chat and check before sending another.')
      expect(
        [...document.querySelectorAll('button')].some((row) => row.textContent === 'Retry')
      ).toBe(false)
      return
    }
    expect(remote.getNativeChatRestartOffer().candidates.map((row) => row.sessionId)).toEqual([
      'chat-1024'
    ])
    expect(button('Resume all 1 on Server').disabled).toBe(false)
    failedRead = false
    await act(async () => button('Resume all 1 on Server').click())
    expect(chunks).toBe(3)
    expect(
      rpc.mock.calls.findLast((call) => call[1] === 'agentSession.restartContinue')?.[2]
    ).toEqual({ sessionIds: ['chat-1024'] })
  }
)

it.each(['failure', 'success', 'history'])(
  'supersedes an older ordinary read through all awaits (%s)',
  async (mode) => {
    const remote = store()
    rpc.mockResolvedValue({ sessions: offered })
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    const old = Promise.withResolvers<unknown>()
    const history = Promise.withResolvers<string[]>()
    if (mode === 'history') {
      vi.stubGlobal('api', {
        runtimeEnvironments: { desktopCreatedChatIds: () => history.promise }
      })
      rpc.mockResolvedValueOnce({ sessions: [] })
      await act(async () => remote.refreshNativeChatRestartOffer())
      rpc.mockResolvedValue({ sessions: offered })
    } else {
      rpc.mockReturnValueOnce(old.promise)
    }
    let read: Promise<void>
    await act(async () => {
      read = remote.refreshNativeChatRestartOffer()
    })
    rpc.mockResolvedValue({ sessions: mode === 'failure' ? offered : [] })
    remote.observeRuntimeStatus(undefined)
    await act(async () => remote.observeRuntimeStatus(ready('r1')))
    await act(async () => {
      if (mode === 'failure') {
        old.reject(new Error('obsolete failure'))
      } else {
        old.resolve({ sessions: offered })
      }
      history.resolve(['a'])
      await read!
    })
    expect(remote.getNativeChatRestartOffer().candidates).toHaveLength(mode === 'failure' ? 2 : 0)
    expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(mode === 'failure')
  }
)

it('enrolls an ordinary paired desktop once and shares resuming with target consumers without render discovery', async () => {
  let owner: NativeChatRestartStore | undefined
  const target = { kind: 'environment' as const, environmentId: 'paired-desktop' }
  function Consumer({ lifecycle = true }: { lifecycle?: boolean }) {
    return (
      <>
        {lifecycle && <Lifecycle />}
        <output>{useNativeChatTargetRestartResuming(target).join(',')}</output>
      </>
    )
  }
  function Lifecycle() {
    owner = useNativeChatRestartRuntimes()[0]?.store
    return null
  }
  useAppStore.setState({
    runtimeEnvironments: [
      {
        id: target.environmentId,
        name: 'Desktop',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: 'r1',
        endpoints: [],
        preferredEndpointId: 'none'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([[target.environmentId, ready('r1')]])
  })
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<Consumer />)
  expect(owner?.getNativeChatRestartOffer().candidates).toHaveLength(2)
  const pending = Promise.withResolvers<unknown>()
  rpc.mockReturnValueOnce(pending.promise)
  let action: Promise<void> | undefined
  await act(async () => {
    action = owner?.continueNativeChatRestartOffer(['a'])
  })
  expect(document.querySelector('output')?.textContent).toBe('a')
  await act(async () => useAppStore.setState({ runtimeEnvironments: [] }))
  expect(document.querySelector('output')?.textContent).toBe('')
  await act(async () => {
    pending.resolve({ sessions: [] })
    await action
  })
  const count = rpc.mock.calls.length
  await mount(<Consumer lifecycle={false} />)
  expect(document.querySelector('output')?.textContent).toBe('')
  expect(rpc).toHaveBeenCalledTimes(count)
})

it.each(['available', 'unavailable', 'other-desktop'])(
  'retains unknown retry evidence over host observations (%s)',
  async (mode) => {
    let remote: NativeChatRestartStore | undefined
    let inProgress = false
    let hostFailure = { ...failure('a', 'agent_session_conflict'), failedAt: 10, retryable: true }
    const reply = Promise.withResolvers<unknown>()
    rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.restartResumable') {
        if (inProgress && mode === 'unavailable') {
          throw new Error('read unavailable')
        }
        return { sessions: [], failed: [hostFailure] }
      }
      expect(params).toEqual({ sessionIds: ['a'] })
      // Another desktop settles F20 before this request reserves it; reservation retains failure.
      if (mode === 'other-desktop') {
        hostFailure = { ...hostFailure, failedAt: 20 }
      }
      inProgress = true
      return reply.promise
    })
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, experimentalNativeChat: false },
      runtimeEnvironments: [
        {
          id: 'ssh',
          name: 'Server',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: 'r1',
          endpoints: [],
          preferredEndpointId: 'none'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([['ssh', ready('r1')]])
    })
    function Fixture() {
      remote = useNativeChatRestartRuntimes()[0]?.store
      return (
        <>
          <NativeChatResumeStatusSegment iconOnly={false} />
          {remote && (
            <NativeChatResumeRuntimeModal store={remote} machineName="Server" offerEnabled />
          )}
        </>
      )
    }
    await mount(<Fixture />)
    await act(async () => button('Server: 1 chat failed to resume. Click for details.').click())
    await act(async () => button('Retry').click())
    expect(inProgress).toBe(true)
    expect(hostFailure.failedAt).toBe(mode === 'other-desktop' ? 20 : 10)
    await act(async () => {
      reply.reject(new Error('Timed out waiting for the remote Orca runtime to respond.'))
    })
    expect(remote!.getNativeChatRestartRun()?.continued).toEqual([
      { sessionId: 'a', outcome: 'unknown' }
    ])
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'Couldn’t confirm 1 chat was resumed',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Review' }) })
    )
    const statusLabel = 'Server: 1 chat to check after resuming. Click for details.'
    expect(document.querySelectorAll(`button[aria-label="${statusLabel}"]`)).toHaveLength(1)
    await act(async () => button(statusLabel).click())
    expect(document.body.textContent).toContain('Open the chat and check before sending another.')
    expect(
      [...document.querySelectorAll('button')].some((row) => row.textContent === 'Retry')
    ).toBe(false)
    expect(document.querySelector('[role="checkbox"][data-state="checked"]')).toBeNull()
    expect(button('Open chat')).toBeTruthy()
    await act(async () => remote!.reopenNativeChatRestartOffer())
    expect(document.body.textContent).toContain('Open the chat and check before sending another.')
    expect(
      rpc.mock.calls.filter((call) => call[1] === 'agentSession.restartContinue')
    ).toHaveLength(1)
    expect(remote!.getNativeChatRestartOffer().failed[0]).toEqual({
      ...hostFailure,
      executionHostId: 'runtime:ssh'
    })
    await act(async () => button('Close').click())
    expect(remote!.getNativeChatRestartRun()).toBeNull()
    await act(async () => remote!.reopenNativeChatRestartOffer())
    expect(button('Retry')).toBeTruthy()
    expect(document.body.textContent).not.toContain(
      'Open the chat and check before sending another.'
    )
    await act(async () => useAppStore.setState({ runtimeEnvironments: [] }))
  }
)
