// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState>) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: TestStore | null
    subscribeStatus: ReturnType<typeof vi.fn>
    supportsCapability: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    supportsCapability: vi.fn(),
    unsubscribe: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { useAppStore } from '@/store'
import { notifyStructuredLaunchListeners } from '@/lib/structured-agent-session-launch-registry'
import {
  writeStructuredAgentLaunchRecord,
  deleteStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

const floatingTab = {
  id: 'floating-chat-1',
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  groupId: 'floating-group',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex',
  executionHostId: LOCAL_EXECUTION_HOST_ID
} satisfies Tab

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...overrides
  }
}

function emit(event: AgentSessionStatusEvent): void {
  const call = mocks.subscribeStatus.mock.calls.at(-1)
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  const send: (event: AgentSessionStatusEvent) => void = call[1]
  act(() => send(event))
}

function pins(): AppState['structuredSessionLaunchDirectoryByTabId'] {
  return mocks.store?.getState().structuredSessionLaunchDirectoryByTabId ?? {}
}

function statuses() {
  return Object.values(useAppStore.getState().agentStatusByPaneKey)
}
function feed(index = 0): { emit: (event: AgentSessionStatusEvent) => void } {
  return { emit: mocks.subscribeStatus.mock.calls[index][1] }
}

describe('StructuredAgentSessionStatusBridge pinned launch directory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      structuredSessionLaunchDirectoryByTabId: {},
      structuredChatSleptAtByPaneKey: {},
      agentStatusByPaneKey: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it.each([4, 40])(
    'commits one status snapshot per host for %i represented sessions',
    async (count) => {
      const local = getStructuredAgentSessionStatusFeed({ kind: 'local' })
      const remote = getStructuredAgentSessionStatusFeed({
        kind: 'environment',
        environmentId: 'paired'
      })
      const leases = [vi.spyOn(local, 'activate'), vi.spyOn(remote, 'activate')]
      const listeners = [vi.spyOn(local, 'subscribe'), vi.spyOn(remote, 'subscribe')]
      const tabs = Array.from({ length: count }, (_, i) => ({
        ...floatingTab,
        id: `chat-${i}`,
        entityId: `session-${i}`,
        executionHostId: i % 2 ? 'runtime:paired' : 'local'
      }))
      useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs } })
      let commits = 0
      const stop = useAppStore.subscribe((state, previous) => {
        if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
          commits += 1
        }
      })
      const view = render(<StructuredAgentSessionStatusBridge />)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
      const rows = tabs.map((tab, i) => summary({ sessionId: tab.entityId, updatedAt: 100 + i }))
      act(() => feed(0).emit({ type: 'snapshot', sessions: rows }))
      expect(commits).toBe(1)
      expect(statuses()).toHaveLength(count / 2)
      act(() => feed(1).emit({ type: 'snapshot', sessions: rows }))
      expect(commits).toBe(2)
      for (const spy of [...leases, ...listeners]) {
        expect(spy).toHaveBeenCalledOnce()
      }
      expect(statuses()).toHaveLength(count)
      const before = useAppStore.getState().agentStatusByPaneKey
      act(() => {
        feed(0).emit({ type: 'snapshot', sessions: rows })
        feed(1).emit({ type: 'snapshot', sessions: rows })
      })
      expect(commits).toBe(2)
      expect(useAppStore.getState().agentStatusByPaneKey).toBe(before)
      stop()
      view.unmount()
      for (const spy of [...leases, ...listeners]) {
        spy.mockRestore()
      }
    }
  )

  it('reads earlier projections in an outer transaction for same-pane clock continuity', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() =>
      useAppStore.getState().transactAgentStatuses(() => {
        feed().emit({ type: 'status', session: summary({ status: 'working', updatedAt: 100 }) })
        feed().emit({ type: 'status', session: summary({ status: 'working', updatedAt: 200 }) })
      })
    )
    expect(statuses()[0]).toMatchObject({
      updatedAt: 200,
      stateStartedAt: 100,
      mainAgent: { stateStartedAt: 100 }
    })
  })

  it('isolates an installed revocation failure and still reconnects and projects', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let stop = () => {}
    let later = () => {}
    try {
      render(<StructuredAgentSessionStatusBridge />)
      await act(() => Promise.resolve())
      act(() =>
        feed().emit({
          type: 'status',
          session: summary({ status: 'working', hostExecutionOwned: true })
        })
      )
      const transaction = vi.spyOn(useAppStore.getState(), 'transactAgentStatuses')
      const afterBridge = vi.fn()
      later = getStructuredAgentSessionStatusFeed({ kind: 'local' }).subscribe(afterBridge)
      let threw = false
      stop = useAppStore.subscribe((state) => {
        if (!threw && !Object.values(state.agentStatusByPaneKey)[0]?.structuredHostOwned) {
          threw = true
          throw new Error('revocation subscriber failed')
        }
      })
      act(() => expect(() => feed().emit({ type: 'end' })).not.toThrow())
      expect(statuses()[0].structuredHostOwned).toBeUndefined()
      expect(warning).toHaveBeenCalled()
      expect(afterBridge).toHaveBeenCalledTimes(2)
      // The second disconnect emission retries the unconsumed input even though the row installed.
      expect(transaction).toHaveBeenCalledTimes(2)
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2)
      act(() =>
        feed(1).emit({
          type: 'snapshot',
          sessions: [summary({ status: 'working', hostExecutionOwned: true, updatedAt: 20 })]
        })
      )
      expect(statuses()[0]).toMatchObject({ structuredHostOwned: true, updatedAt: 20 })
      transaction.mockRestore()
    } finally {
      stop()
      later()
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  it('projects a launch failure without a feed row and clears it on retry', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    for (const failedAt of [42, undefined]) {
      act(() => {
        writeStructuredAgentLaunchRecord({
          sessionId: floatingTab.entityId,
          agent: 'codex',
          executionHostId: 'local',
          lifecycle: 'failed',
          clientOperationId: 'failure-test',
          payloadFingerprint: 'failure-test',
          expectedRuntimeFence: null,
          failedAt
        })
        notifyStructuredLaunchListeners()
      })
      expect(statuses()[0]).toMatchObject({
        state: 'done',
        updatedAt: failedAt ?? floatingTab.createdAt,
        mainAgent: { outcome: 'failure' }
      })
      act(() => {
        deleteStructuredAgentLaunchRecord(floatingTab.entityId)
        notifyStructuredLaunchListeners()
      })
      expect(statuses()).toHaveLength(0)
    }
  })

  it.each([100, undefined])(
    'preserves warm host-move markers and clock with authoritative start %s',
    async (statusStartedAt) => {
      render(<StructuredAgentSessionStatusBridge />)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
      act(() =>
        feed().emit({
          type: 'status',
          session: summary({ status: 'working', updatedAt: 100, statusStartedAt })
        })
      )
      const paneKey = statuses()[0].paneKey
      const acknowledged = { [paneKey]: 999 }
      const manual = { [paneKey]: 100 }
      const cleared = { [paneKey]: 90 }
      useAppStore.getState().registerAgentLaunchConfig(paneKey, { agentArgs: '', agentEnv: {} })
      const configs = useAppStore.getState().agentLaunchConfigByPaneKey
      useAppStore.setState({
        acknowledgedAgentsByPaneKey: acknowledged,
        manuallyUnreadTurnsByPaneKey: manual,
        activityClearedAtByPaneKey: cleared
      })
      const remote = getStructuredAgentSessionStatusFeed({
        kind: 'environment',
        environmentId: 'paired'
      })
      const release = remote.activate()
      try {
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
        act(() =>
          feed(1).emit({
            type: 'snapshot',
            sessions: [summary({ status: 'working', updatedAt: 200, statusStartedAt })]
          })
        )
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [
                { ...floatingTab, executionHostId: 'runtime:paired' }
              ]
            }
          })
        )
        const assertContinuity = () => {
          expect(statuses()[0]).toMatchObject({
            updatedAt: 200,
            stateStartedAt: 100,
            mainAgent: { stateStartedAt: 100 }
          })
          expect(useAppStore.getState().acknowledgedAgentsByPaneKey).toBe(acknowledged)
          expect(useAppStore.getState().manuallyUnreadTurnsByPaneKey).toBe(manual)
          expect(useAppStore.getState().activityClearedAtByPaneKey).toBe(cleared)
          expect(useAppStore.getState().agentLaunchConfigByPaneKey).toBe(configs)
        }
        assertContinuity()
        act(() =>
          feed().emit({ type: 'status', session: summary({ status: 'attention', updatedAt: 300 }) })
        )
        assertContinuity()
        act(() =>
          feed(1).emit({
            type: 'status',
            session: summary({ status: 'working', updatedAt: 200, statusStartedAt })
          })
        )
        assertContinuity()
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...floatingTab, executionHostId: 'runtime:cold' }]
            }
          })
        )
        expect(statuses()).toHaveLength(0)
        expect(useAppStore.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(3))
        act(() =>
          feed(2).emit({
            type: 'snapshot',
            sessions: [summary({ status: 'working', updatedAt: 400, statusStartedAt })]
          })
        )
        expect(statuses()[0].stateStartedAt).toBe(statusStartedAt ?? 400)
        act(() =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              [FLOATING_TERMINAL_WORKTREE_ID]: [
                { ...floatingTab, entityId: 'replacement', executionHostId: 'runtime:cold' }
              ]
            }
          })
        )
        expect(statuses()).toHaveLength(0)
      } finally {
        release()
      }
    }
  )

  it('keeps the host-published pinned folder for the tab and drops it when the tab goes', async () => {
    const view = render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/home/me/original' })] })

    expect(pins()).toEqual({
      [floatingTab.id]: { sessionId: 'session-1', launchDirectory: '/home/me/original' }
    })

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: {} }))
    view.rerender(<StructuredAgentSessionStatusBridge />)
    expect(pins()).toEqual({})
  })

  it.each([
    { label: 'Renamed' },
    { agentSessionAgent: 'claude' as const },
    { worktreeId: 'another-workspace' }
  ])('keeps sleep and directory untouched for metadata %j', async (metadata) => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    emit({ type: 'snapshot', sessions: [summary({ sleptAt: 5, launchDirectory: '/project' })] })
    const state = useAppStore.getState()
    const slept = state.structuredChatSleptAtByPaneKey
    const directory = state.structuredSessionLaunchDirectoryByTabId
    const originalActions = {
      setStructuredChatSleptAt: state.setStructuredChatSleptAt,
      setStructuredSessionLaunchDirectory: state.setStructuredSessionLaunchDirectory,
      clearStructuredSessionLaunchDirectory: state.clearStructuredSessionLaunchDirectory
    }
    const sleepSetter = vi.spyOn(state, 'setStructuredChatSleptAt')
    const directorySetter = vi.spyOn(state, 'setStructuredSessionLaunchDirectory')
    const directoryClear = vi.spyOn(state, 'clearStructuredSessionLaunchDirectory')
    let publications = 0
    const stop = useAppStore.subscribe((next, previous) => {
      if (
        next.structuredChatSleptAtByPaneKey !== previous.structuredChatSleptAtByPaneKey ||
        next.structuredSessionLaunchDirectoryByTabId !==
          previous.structuredSessionLaunchDirectoryByTabId
      ) {
        publications += 1
      }
    })
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [{ ...floatingTab, ...metadata }]
        }
      })
    )
    expect(Object.values(useAppStore.getState().agentStatusByPaneKey)[0]).toMatchObject({
      terminalTitle: metadata.label ?? floatingTab.label,
      agentType: metadata.agentSessionAgent ?? floatingTab.agentSessionAgent,
      worktreeId: metadata.worktreeId ?? floatingTab.worktreeId
    })
    expect(useAppStore.getState().structuredChatSleptAtByPaneKey).toBe(slept)
    expect(useAppStore.getState().structuredSessionLaunchDirectoryByTabId).toBe(directory)
    expect(publications).toBe(0)
    expect(sleepSetter).not.toHaveBeenCalled()
    expect(directorySetter).not.toHaveBeenCalled()
    expect(directoryClear).not.toHaveBeenCalled()
    stop()
    sleepSetter.mockRestore()
    directorySetter.mockRestore()
    directoryClear.mockRestore()
    useAppStore.setState(originalActions)
  })

  it('records nothing when an older host omits the field', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary()] })

    expect(pins()).toEqual({})
  })

  it('never records a path published by a remote runtime', async () => {
    // The tab records the paired host that owns the chat.
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { ...floatingTab, executionHostId: toRuntimeExecutionHostId('env-1') }
        ]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/srv/remote/floating' })] })

    // The summary itself landed; only its path was withheld.
    expect(Object.keys(mocks.store?.getState().agentStatusByPaneKey ?? {})).toHaveLength(1)
    expect(pins()).toEqual({})
  })
})
