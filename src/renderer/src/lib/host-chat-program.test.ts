import { getDefaultSourceControlAiSettings } from '../../../shared/source-control-ai-settings'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY as INSTALL } from '../../../shared/managed-runtime-install'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as HEALTH,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as MODE
} from '../../../shared/protocol-version'
const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: rpc.subscribe }))
import { useAppStore } from '@/store'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { acquireAgentLaunchChoices, holdChatProgramFacts } from './host-chat-program-acquisition'
import { agentChoicePending, agentChoiceOpensAsChat, readChatProgram } from './host-chat-program'
import { resolveQuickWorkspaceAgentSelection } from './quick-workspace-agent-selection'
import { resolveChecksActionAgent, startFixChecksAgent } from './fix-checks-agent-launch'
const launch = vi.hoisted(() => ({ direct: vi.fn() }))
vi.mock('./launch-work-item-direct', () => ({ launchWorkItemDirect: launch.direct }))
const CAPS = [CHAT, CATALOG, INSTALL, HEALTH, MODE]
const workspace = { kind: 'git-worktree', runtimeEnvironmentId: 'B' } as const
const host = { executionHostId: 'runtime:B', hostCapabilities: CAPS }
const initial = useAppStore.getState()
const status = (runtimeId = 'r1') => ({
  status: {
    runtimeId,
    capabilities: CAPS,
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  },
  checkedAt: 1
})
const catalog = {
  agents: [
    { agent: 'antigravity', capabilities: {}, managedRuntime: true },
    { agent: 'grok', capabilities: {} }
  ]
}
const frame = (agent: string, chatProgram: string) => ({
  type: 'availability',
  agents: [{ agent, state: 'available', chatProgram }]
})
const flush = () =>
  Array.from({ length: 12 }).reduce<Promise<void>>((tick) => tick.then(), Promise.resolve())
beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue(catalog)
  rpc.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn() })
  setLocalRuntimeCapabilitiesForTests(CAPS)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      defaultTuiAgent: null
    },
    runtimeStatusByEnvironmentId: new Map([['B', status()]])
  })
})
afterEach(() => {
  vi.useRealTimers()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initial, true)
})

it('acquires inactive B independently of detection, preserves unknown truth and selected catalog intent', async () => {
  let catalogReply: (reply: unknown) => void = () => {}
  rpc.call.mockReturnValue(
    new Promise((resolve) => {
      catalogReply = resolve
    })
  )
  const action = acquireAgentLaunchChoices(workspace, async () => [])
  await flush()
  expect(rpc.subscribe.mock.calls[0][0]).toEqual({ kind: 'environment', environmentId: 'B' })
  expect(agentChoicePending(useAppStore.getState(), 'antigravity', workspace, [])).toBe(true)
  expect(
    resolveQuickWorkspaceAgentSelection({
      quickAgentOverride: 'antigravity',
      preferredQuickAgent: null,
      detectedAgentIds: [],
      selectedChoiceUnresolved: true
    }).quickAgentOverride
  ).toBe('antigravity')
  rpc.subscribe.mock.calls[0][3].onEvent(frame('grok', 'available'))
  catalogReply(catalog)
  expect((await action).offered).toEqual(['grok'])
  expect(rpc.call).toHaveBeenCalled()
  const lease = holdChatProgramFacts(workspace)
  rpc.subscribe.mock.calls.at(-1)![3].onEvent(frame('grok', 'future-program'))
  expect(readChatProgram(useAppStore.getState(), 'grok', host, ['grok'])).toBe('unknown')
  expect(agentChoiceOpensAsChat(useAppStore.getState(), 'grok', workspace, ['grok'])).toBe(true)
  lease.release()
})

it('releases a pending stream at the chat deadline while slow ordinary detection keeps waiting', async () => {
  vi.useFakeTimers()
  let handle: (value: { unsubscribe: () => void }) => void = () => {}
  let detect: (ids: []) => void = () => {}
  rpc.subscribe.mockReturnValue(
    new Promise((resolve) => {
      handle = resolve
    })
  )
  const action = acquireAgentLaunchChoices(
    workspace,
    () =>
      new Promise<[]>((resolve) => {
        detect = resolve
      })
  )
  let done = false
  void action.then(() => {
    done = true
  })
  await flush()
  await vi.advanceTimersByTimeAsync(5000)
  expect(done).toBe(false)
  const unsubscribe = vi.fn()
  handle({ unsubscribe })
  await flush()
  expect(unsubscribe).toHaveBeenCalledOnce()
  detect([])
  await action
  expect(done).toBe(true)
})

it('waits for each reopened first frame and cancels genuine runtime replacement, not cold learning', async () => {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const abort = new AbortController()
  const action = acquireAgentLaunchChoices(workspace, async () => [], abort.signal)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['B', status()]]) })
  await flush()
  const handlers = rpc.subscribe.mock.calls.at(-1)![3]
  handlers.onEvent(frame('grok', 'available'))
  await action
  await flush()
  let done = false
  const reopened = acquireAgentLaunchChoices(workspace, async () => []).then(() => {
    done = true
  })
  await flush()
  expect(done).toBe(false)
  rpc.subscribe.mock.calls.at(-1)![3].onClose()
  await reopened
  const replaced = acquireAgentLaunchChoices(workspace, () => new Promise<[]>(() => {}))
  const rejected = expect(replaced).rejects.toThrow('owner changed')
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['B', status('r2')]]) })
  await rejected
})

it('adapts only absent publication on older hosts and shares the saved Checks gate with pre-create execution', async () => {
  setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, INSTALL])
  const local = { kind: 'git-worktree' } as const
  const settings = {
    ...getDefaultSettings('/tmp'),
    experimentalNativeChat: true,
    defaultTuiAgent: null,
    sourceControlAi: {
      ...getDefaultSourceControlAiSettings(),
      actions: { fixChecks: { agentId: 'antigravity', commandInputTemplate: '{basePrompt}' } }
    }
  }
  useAppStore.setState({ settings, ensureDetectedAgents: async () => [] })
  await acquireAgentLaunchChoices(local, async () => [])
  expect(resolveChecksActionAgent(useAppStore.getState(), 'fixChecks', undefined, local, [])).toBe(
    'antigravity'
  )
  expect(
    resolveChecksActionAgent(useAppStore.getState(), 'resolveComments', undefined, local, [])
  ).toBeNull()
  launch.direct.mockResolvedValue(true)
  await startFixChecksAgent({
    repoId: 'missing',
    basePrompt: 'fix checks',
    item: {
      number: 1,
      url: 'https://example.test/1',
      title: 'PR',
      id: 'pr1',
      type: 'pr',
      state: 'open',
      labels: [],
      updatedAt: '',
      author: null,
      repoId: 'missing'
    },
    launchSource: 'task_page',
    openModalFallback: vi.fn()
  })
  expect(launch.direct).toHaveBeenCalledWith(
    expect.objectContaining({ agentOverride: 'antigravity' })
  )
  useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['antigravity'] } })
  expect(
    resolveChecksActionAgent(useAppStore.getState(), 'fixChecks', undefined, local, [])
  ).toBeNull()
  expect(
    readChatProgram(
      useAppStore.getState(),
      'antigravity',
      { executionHostId: 'local', hostCapabilities: [CHAT] },
      []
    )
  ).toBe('missing')
})
