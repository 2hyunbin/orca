// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  readHostStructuredAgents,
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { HostCreateSupport } from '@/lib/structured-agent-session-host-admission'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), support: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.support
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex'] })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local',
  parseAgentDetectionTargetKey: () => ({ kind: 'local' }),
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  workspaceKindForWorktreeId: () => 'git-worktree',
  buildAgentLaunchRouteInput: (
    state: ReturnType<typeof useAppStore.getState>,
    { agent }: { agent: string }
  ) => {
    const host = state.activeWorkspaceExecutionHostId ?? 'local'
    return {
      agent,
      settings: state.settings,
      executionHostId: host,
      hostCapabilities: readLocalRuntimeCapabilitiesOrUnknown(),
      clientCapabilities: readLocalRuntimeCapabilitiesOrUnknown() ?? [],
      workspaceKind: 'git-worktree',
      nativeChatTranscriptIsLocalReadable: true,
      hostStructuredAgents: readHostStructuredAgents(host, state.runtimeStatusByEnvironmentId)?.map(
        (row) => row.agent
      )
    }
  }
}))
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
const capabilities = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]
const initial = useAppStore.getState()
const catalog = {
  agents: ['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} }))
}
const pending: { resolve: (answer: HostCreateSupport) => void; signal: AbortSignal }[] = []
beforeEach(() => {
  vi.useFakeTimers()
  mocks.rpc.mockReset().mockResolvedValue(catalog)
  pending.length = 0
  mocks.support
    .mockReset()
    .mockImplementation(
      (_target, _selector, _agent, options) =>
        new Promise<HostCreateSupport>((resolve) =>
          pending.push({ resolve, signal: options.signal })
        )
    )
  useAppStore.setState({
    ...initial,
    settings: {
      ...initial.settings,
      experimentalNativeChat: true,
      disabledTuiAgents: [],
      nativeChatProviders: { opencode: false }
    },
    detectedAgentIds: ['claude', 'codex', 'opencode'],
    runtimeStatusByEnvironmentId: new Map(),
    activeWorkspaceExecutionHostId: null
  })
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(capabilities)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('owns finite reads only while open, shares live work, and retires same-key reopen and timeout', async () => {
  await loadHostStructuredAgents('local', capabilities, null)
  const a = renderHook(
    ({ open, query }) => {
      void query
      return useNewTabAgentMenuRows('wt', open)
    },
    { initialProps: { open: false, query: '' } }
  )
  expect(mocks.support).not.toHaveBeenCalled()
  a.rerender({ open: true, query: '' })
  const b = renderHook(() => useNewTabAgentMenuRows('wt', true))
  expect(mocks.support).toHaveBeenCalledTimes(2)
  a.rerender({ open: true, query: 'codex' })
  act(() => useAppStore.setState({ activeTabId: 'unrelated' }))
  expect(mocks.support).toHaveBeenCalledTimes(2)
  a.rerender({ open: false, query: '' })
  expect(pending[0]?.signal.aborted).toBe(false)
  b.unmount()
  expect(pending[0]?.signal.aborted).toBe(true)
  a.rerender({ open: true, query: '' })
  expect(mocks.support).toHaveBeenCalledTimes(4)
  await act(async () => {
    pending[0]?.resolve({ kind: 'admitted' })
    pending[1]?.resolve({ kind: 'admitted' })
  })
  expect(a.result.current.rows.some((row) => row.kind === 'chat')).toBe(false)
  await act(async () => pending.slice(2).forEach((read) => read.resolve({ kind: 'admitted' })))
  a.rerender({ open: true, query: 'claude' })
  act(() => useAppStore.setState({ activeTabId: 'another-unrelated-write' }))
  expect(a.result.current.rows.some((row) => row.kind === 'chat')).toBe(true)
  expect(mocks.support).toHaveBeenCalledTimes(4)
  const oldModel = a.result.current
  const oldSelection = oldModel.rows.find((row) => row.kind === 'chat')!
  a.rerender({ open: false, query: '' })
  expect(oldModel.validate(oldSelection)).toBe(false)
  a.rerender({ open: true, query: '' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(pending[4]?.signal.aborted).toBe(true)
  expect(a.result.current.rows.find((row) => row.agent === 'claude')).toMatchObject({
    reason: 'not-on-host'
  })
  expect(mocks.support).toHaveBeenCalledTimes(6)
})

it('invalidates selected authority and late answers on config, owner, runtime, connection and re-pair changes', async () => {
  await loadHostStructuredAgents('local', capabilities, null)
  const hook = renderHook(() => useNewTabAgentMenuRows('wt', true))
  await act(async () => pending.slice().forEach((read) => read.resolve({ kind: 'admitted' })))
  const selected = hook.result.current.rows.find((row) => row.kind === 'chat')!
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings, agentCmdOverrides: { claude: 'other' } }
    }))
  )
  expect(hook.result.current.validate(selected)).toBe(false)
  const status = {
    runtimeId: 'runtime-1',
    capabilities,
    rendererGraphEpoch: 1,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
  for (const [runtimeId, connectionGeneration, pairingRevision] of [
    ['runtime-1', 1, 1],
    ['runtime-2', 1, 1],
    ['runtime-2', 2, 1],
    ['runtime-2', 2, 2]
  ] as const) {
    await act(async () => {
      replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1, pairingRevision }])
      useAppStore.setState({
        activeWorkspaceExecutionHostId: 'runtime:server',
        runtimeStatusByEnvironmentId: new Map([
          ['server', { status: { ...status, runtimeId }, checkedAt: 1, connectionGeneration }]
        ])
      })
      await loadHostStructuredAgents('runtime:server', capabilities, runtimeId)
    })
    expect(hook.result.current.rows.some((row) => row.kind === 'chat')).toBe(false)
  }
  expect(mocks.support.mock.calls.at(-1)?.[3]).toMatchObject({
    expectedEnvironmentRuntimeId: 'runtime-2',
    expectedEnvironmentPairingRevision: 2
  })
  const beforeReconnect = mocks.support.mock.calls.length
  const peer = renderHook(() => useNewTabAgentMenuRows('wt', true))
  expect(mocks.support).toHaveBeenCalledTimes(beforeReconnect)
  await act(async () =>
    useAppStore.setState((state) => ({
      runtimeStatusByEnvironmentId: new Map([
        ['server', { ...state.runtimeStatusByEnvironmentId.get('server')!, hostContactEpoch: 1 }]
      ])
    }))
  )
  expect(pending[beforeReconnect - 1]?.signal.aborted).toBe(true)
  expect(mocks.support).toHaveBeenCalledTimes(beforeReconnect + 2)
  peer.unmount()
  await act(async () => pending.slice(2, -2).forEach((read) => read.resolve({ kind: 'admitted' })))
  expect(hook.result.current.rows.some((row) => row.kind === 'chat')).toBe(false)
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings, disabledTuiAgents: ['claude'] }
    }))
  )
  expect(hook.result.current.rows.some((row) => row.agent === 'claude')).toBe(false)
})

it('keeps null SSH inventory named without probing and recovers an unlearned catalog on reopen', async () => {
  act(() =>
    useAppStore.setState({ detectedAgentIds: null, activeWorkspaceExecutionHostId: 'ssh:server' })
  )
  const hook = renderHook(({ open }) => useNewTabAgentMenuRows('wt', open), {
    initialProps: { open: true }
  })
  expect(hook.result.current.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agent: 'claude', reason: 'ssh' }),
      expect.objectContaining({ agent: 'codex', reason: 'ssh' })
    ])
  )
  expect(mocks.support).not.toHaveBeenCalled()
  mocks.rpc.mockResolvedValueOnce(null)
  await act(async () =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings, nativeChatProviders: {} },
      activeWorkspaceExecutionHostId: null,
      detectedAgentIds: ['claude', 'opencode']
    }))
  )
  expect(mocks.support).not.toHaveBeenCalled()
  hook.rerender({ open: false })
  await act(async () => hook.rerender({ open: true }))
  expect(mocks.support).toHaveBeenCalledTimes(3)
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
  await act(async () => pending.forEach((read) => read.resolve({ kind: 'admitted' })))
  expect(hook.result.current.rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ agent: 'opencode', kind: 'chat' })])
  )
  act(() => setLocalRuntimeCapabilitiesForTests([]))
  hook.rerender({ open: true })
  expect(hook.result.current.rows.every((row) => row.kind === 'terminal')).toBe(true)
})
