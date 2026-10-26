// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'
import { resolveNativeChatHookState } from './use-native-chat-hook-status'

describe('resolveNativeChatHookState', () => {
  const now = 1_000_000

  it('does not treat a restored working row as live activity', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: true
        },
        now
      )
    ).toBeNull()
  })

  it('keeps confirmed working activity live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBe('working')
  })

  it('continues to suppress monitoring rows', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: 'monitoring',
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })

  it('does not keep an expired working row live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now - 30 * 60 * 1000 - 1,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })
})

afterEach(() => {
  cleanup()
  useAppStore.getState().flushAgentStatuses()
  for (const key of Object.keys(useAppStore.getState().agentStatusByPaneKey)) {
    useAppStore.getState().removeAgentStatus(key)
  }
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.useRealTimers()
})

it('keeps both hooks quiet on another pane finishing and still observes its own silent expiry', async () => {
  vi.useFakeTimers()
  const start = AGENT_STATUS_STALE_AFTER_MS * 10
  vi.setSystemTime(start)
  const messages: NativeChatMessage[] = [
    { id: 'turn', role: 'user', blocks: [], timestamp: start, source: 'transcript' }
  ]
  for (const paneKey of ['own:1', 'other:1']) {
    useAppStore
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'task', agentType: 'claude' },
        undefined,
        { updatedAt: start, evidenceObservedAt: start, turnStartedAt: start }
      )
  }
  let renders = 0
  const hook = renderHook(() => {
    renders++
    return [
      useNativeChatHookStatus('own:1'),
      useNativeChatTerminalTurnTiming('own:1', messages, false)
    ] as const
  })
  const before = renders
  act(() => {
    useAppStore.getState().setAgentStatus('other:1', { state: 'done', prompt: 'task' })
    useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
  })
  expect(renders).toBe(before)
  expect(hook.result.current[0][0]).toBe('working')
  await act(async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
  })
  expect(hook.result.current[0][0]).toBeNull()
  expect(hook.result.current[1].settledTurns.get('turn')).toBeNull()
})

it('publishes queued status patches once per frame in order and flushes before synchronous status actions', () => {
  vi.useFakeTimers()
  const writes = vi.fn()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
      writes()
    }
  })
  const queue = (prompt: string): void =>
    useAppStore.getState().queueAgentStatuses((transaction) => {
      transaction.apply({
        paneKey: 'queued:1',
        payload: { state: 'working', prompt, agentType: 'claude' }
      })
    })
  try {
    queue('first')
    queue('second')
    expect(writes).not.toHaveBeenCalled()
    act(() => vi.advanceTimersToNextFrame())
    expect(writes).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentStatusByPaneKey['queued:1'].prompt).toBe('second')
    queue('third')
    useAppStore.getState().transactAgentStatuses((transaction) => {
      expect(transaction.getState().agentStatusByPaneKey['queued:1'].prompt).toBe('third')
    })
    expect(writes).toHaveBeenCalledTimes(2)
    queue('fourth')
    useAppStore.getState().removeAgentStatus('queued:1')
    expect(useAppStore.getState().agentStatusByPaneKey['queued:1']).toBeUndefined()
    act(() => vi.advanceTimersToNextFrame())
    expect(useAppStore.getState().agentStatusByPaneKey['queued:1']).toBeUndefined()
  } finally {
    unsubscribe()
  }
})
