// @vitest-environment happy-dom
import { act } from 'react'
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
      { sessionIds: ids }
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
      rpc.mockRejectedValue(new Error('method not found'))
    }
    await act(async () => remote.observeRuntimeStatus(ready('old')))
    expect(remote.getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    expect(remote.getNativeChatRestartOffer().candidates).toEqual([])
  }
)
