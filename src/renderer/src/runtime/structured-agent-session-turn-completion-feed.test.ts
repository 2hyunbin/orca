// Keep completion/prompt edges live-only: no late snapshot, buffering or reconnect catch-up, which would mark already-read work unread again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  getStructuredAgentSessionTurnCompletionFeed,
  resetStructuredAgentSessionTurnCompletionFeedsForTests
} from './structured-agent-session-turn-completion-feed'

function label(edge: AgentSessionAttentionEdge): string {
  return edge.type === 'completion' ? edge.completion.turnId : `prompt:${edge.prompt.promptId}`
}

type Subscription = {
  emit: (event: AgentSessionTurnCompletionEvent) => void
  fail: (error: unknown) => void
  close: () => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: Subscription[] = []

function subscription(index = 0): Subscription {
  const value = subscriptions[index]
  if (!value) {
    throw new Error(`missing subscription ${index}; opened ${subscriptions.length}`)
  }
  return value
}

function completion(turnId: string): AgentSessionTurnCompletion {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    sessionId: 'session-1',
    turnId,
    outcome: 'success',
    completedAt: 1
  }
}

describe('structured turn completion feed (renderer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    subscriptions.length = 0
    mocks.subscribe.mockReset()
    mocks.supportsCapability.mockReset()
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.subscribe.mockImplementation(
      (
        _target: unknown,
        emit: Subscription['emit'],
        fail: Subscription['fail'],
        close: Subscription['close']
      ) => {
        const unsubscribe = vi.fn()
        subscriptions.push({ emit, fail, close, unsubscribe })
        return Promise.resolve({ unsubscribe })
      }
    )
  })

  afterEach(() => {
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    vi.useRealTimers()
  })

  it('delivers completions to every listener while the stream is up', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const first: string[] = []
    const second: string[] = []
    feed.subscribe((edge) => first.push(label(edge)))
    feed.subscribe((edge) => second.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    expect(first).toEqual(['turn-1'])
    expect(second).toEqual(['turn-1'])
  })

  it('delivers prompt edges beside completions, and drops an arm it cannot name', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    subscription().emit({
      type: 'prompt',
      prompt: {
        scope: completion('unused').scope,
        sessionId: 'session-1',
        promptId: 'approval-1',
        raisedAt: 1
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a newer host's arm this build cannot type.
    subscription().emit({ type: 'future-edge' } as unknown as AgentSessionTurnCompletionEvent)
    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    expect(seen).toEqual(['prompt:approval-1', 'turn-1'])
  })

  it('replays nothing to a listener that subscribes after a completion landed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('turn-1') })

    const late: string[] = []
    feed.subscribe((edge) => late.push(label(edge)))

    // There is no buffer to hand over. The edge already passed.
    expect(late).toEqual([])
  })

  it('reconnects into an empty stream and never asks the host what it missed', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'completion', completion: completion('before-drop') })

    subscription().close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(subscriptions).toHaveLength(2)

    // Assert target plus callbacks only; adding a catch-up cursor must break this contract.
    for (const call of mocks.subscribe.mock.calls) {
      expect(call).toHaveLength(4)
      expect(call[0]).toEqual({ kind: 'local' })
      expect(call.slice(1).every((argument) => typeof argument === 'function')).toBe(true)
    }

    // Reopened streams deliver only future edges; completions during the gap are lost.
    expect(seen).toEqual(['before-drop'])
    subscription(1).emit({ type: 'completion', completion: completion('after-reconnect') })
    expect(seen).toEqual(['before-drop', 'after-reconnect'])
  })

  it.each([
    ['an end frame', (value: Subscription) => value.emit({ type: 'end' })],
    ['a transport error', (value: Subscription) => value.fail(new Error('relay gone'))],
    ['a close', (value: Subscription) => value.close()]
  ])('reopens after %s', async (_label, drop) => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)

    drop(subscription())
    await vi.advanceTimersByTimeAsync(5_000)

    expect(subscriptions).toHaveLength(2)
  })

  it('does not subscribe a remote host that lacks the capability, and does not retry it', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    const feed = getStructuredAgentSessionTurnCompletionFeed({
      kind: 'environment',
      environmentId: 'env-1'
    })
    feed.activate()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mocks.subscribe).not.toHaveBeenCalled()
    // An old host is a settled answer, not a fault; retrying would probe the relay forever.
    expect(mocks.supportsCapability).toHaveBeenCalledTimes(1)
  })

  it('subscribes a remote host that advertises the capability', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({
      kind: 'environment',
      environmentId: 'env-1'
    })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      'agent-session.turn-completion.v1'
    )
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  })

  it('stops the stream when the last activation is released and opens a fresh one on the next', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    const release = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const opened = subscription()

    release()
    expect(opened.unsubscribe).toHaveBeenCalledTimes(1)

    // A late frame from the torn-down stream reaches nobody.
    const seen: string[] = []
    feed.subscribe((edge) => seen.push(label(edge)))
    opened.emit({ type: 'completion', completion: completion('after-stop') })
    expect(seen).toEqual([])

    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions).toHaveLength(2)
  })

  it('keeps delivering to the other listeners when one throws', async () => {
    const feed = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    feed.activate()
    const seen: string[] = []
    feed.subscribe(() => {
      throw new Error('listener exploded')
    })
    feed.subscribe((edge) => seen.push(label(edge)))
    await vi.advanceTimersByTimeAsync(0)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscription().emit({ type: 'completion', completion: completion('turn-1') })
    warn.mockRestore()

    expect(seen).toEqual(['turn-1'])
  })

  it('hands the same owner to every caller for one target and separate owners per target', () => {
    const local = getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })
    expect(getStructuredAgentSessionTurnCompletionFeed({ kind: 'local' })).toBe(local)
    expect(
      getStructuredAgentSessionTurnCompletionFeed({ kind: 'environment', environmentId: 'env-1' })
    ).not.toBe(local)
  })
})

describe('source forwarding lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    subscriptions.length = 0
    mocks.supportsCapability.mockReset().mockResolvedValue(true)
    mocks.subscribe.mockReset().mockImplementation((_target, emit, fail, close) => {
      const unsubscribe = vi.fn()
      subscriptions.push({ emit, fail, close, unsubscribe })
      return Promise.resolve({ unsubscribe })
    })
  })
  afterEach(() => {
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    vi.useRealTimers()
  })

  it('declares only after the listener, scopes S/S2 independently and evicts released owners', async () => {
    const target = { kind: 'environment', environmentId: 'env-source' } as const
    const first = getStructuredAgentSessionTurnCompletionFeed(target, 'session-1')
    const second = getStructuredAgentSessionTurnCompletionFeed(target, 'session-2')
    const seen: string[] = []
    const stopFirst = first.subscribe((edge) => seen.push(label(edge)))
    const stopSecond = second.subscribe((edge) => seen.push(label(edge)))
    const releaseFirst = first.activate()
    const releaseSecond = second.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions).toHaveLength(2)
    expect(mocks.subscribe.mock.calls.map((call) => call[4])).toEqual(['session-1', 'session-2'])
    subscription(0).emit({ type: 'completion', completion: completion('epoch-one') })
    subscription(0).emit({
      type: 'completion',
      completion: {
        ...completion('epoch-two'),
        journalCursor: { epoch: 'new-epoch', sequence: 1 }
      }
    })
    expect(seen).toEqual(['epoch-one', 'epoch-two'])
    releaseFirst()
    stopFirst()
    expect(subscription(0).unsubscribe).toHaveBeenCalledOnce()
    expect(subscription(1).unsubscribe).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionTurnCompletionFeed(target, 'session-1')).not.toBe(first)
    subscription(1).emit({
      type: 'completion',
      completion: { ...completion('sibling'), sessionId: 'session-2' }
    })
    expect(seen.at(-1)).toBe('sibling')
    releaseSecond()
    stopSecond()
  })

  it('keeps one old-host global stream and never sends a source declaration to it', async () => {
    mocks.supportsCapability.mockImplementation((_id, capability) =>
      Promise.resolve(capability === 'agent-session.turn-completion.v1')
    )
    const target = { kind: 'environment', environmentId: 'old-host' } as const
    const first = getStructuredAgentSessionTurnCompletionFeed(target, 'session-1')
    const second = getStructuredAgentSessionTurnCompletionFeed(target, 'session-2')
    const stopFirst = first.subscribe(() => {})
    const stopSecond = second.subscribe(() => {})
    const releaseFirst = first.activate()
    const releaseSecond = second.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions).toHaveLength(1)
    expect(mocks.subscribe.mock.calls[0]).toHaveLength(6)
    expect(mocks.subscribe.mock.calls[0]![4]).toBeUndefined()
    expect(mocks.subscribe.mock.calls[0]![5]).toBeInstanceOf(AbortSignal)
    releaseFirst()
    stopFirst()
    expect(subscription().unsubscribe).not.toHaveBeenCalled()
    releaseSecond()
    stopSecond()
    expect(subscription().unsubscribe).toHaveBeenCalledOnce()
  })

  it('cancels pending setup, disposes its late handle and rejects old callbacks after rebind', async () => {
    const { replaceRuntimeEnvironmentRevisions } = await import('./runtime-environment-revision')
    replaceRuntimeEnvironmentRevisions([{ id: 'env-source', pairingRevision: 1, createdAt: 1 }])
    const gate = Promise.withResolvers<{ unsubscribe: () => void }>()
    mocks.subscribe.mockReturnValueOnce(gate.promise)
    const target = { kind: 'environment', environmentId: 'env-source' } as const
    const feed = getStructuredAgentSessionTurnCompletionFeed(target, 'session-1')
    const seen: string[] = []
    const stop = feed.subscribe((edge) => seen.push(label(edge)))
    const release = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const old = mocks.subscribe.mock.calls[0]
    const signal: AbortSignal = old[5]
    replaceRuntimeEnvironmentRevisions([{ id: 'env-source', pairingRevision: 2, createdAt: 1 }], {
      retired: ['env-source'],
      sameHost: []
    })
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
    const late = vi.fn()
    gate.resolve({ unsubscribe: late })
    await vi.advanceTimersByTimeAsync(0)
    expect(late).toHaveBeenCalledOnce()
    old[1]({ type: 'completion', completion: completion('old-incarnation') })
    subscription().emit({ type: 'completion', completion: completion('current-incarnation') })
    expect(seen).toEqual(['current-incarnation'])
    release()
    stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
  })

  it.each([8, 80])(
    'owns exactly N=%i streams and returns to baseline after source release',
    async (count) => {
      const target = { kind: 'environment', environmentId: 'many-sources' } as const
      const feeds = Array.from({ length: count }, (_, index) =>
        getStructuredAgentSessionTurnCompletionFeed(target, `source-${index}`)
      )
      const stops = feeds.map((feed) => {
        const stop = feed.subscribe(() => {})
        const release = feed.activate()
        return () => {
          release()
          stop()
        }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(subscriptions).toHaveLength(count)
      expect(mocks.supportsCapability).toHaveBeenCalledTimes(2 * count)
      stops.forEach((stop) => stop())
      for (let index = 0; index < count; index += 1) {
        expect(subscription(index).unsubscribe).toHaveBeenCalledOnce()
        expect(getStructuredAgentSessionTurnCompletionFeed(target, `source-${index}`)).not.toBe(
          feeds[index]
        )
      }
      const replacement = getStructuredAgentSessionTurnCompletionFeed(target, 'source-0')
      const stopReplacement = replacement.subscribe(() => {})
      const releaseReplacement = replacement.activate()
      // A held, previously evicted owner must join the replacement, never open a duplicate.
      const stopHeld = feeds[0]!.subscribe(() => {})
      const releaseHeld = feeds[0]!.activate()
      await vi.advanceTimersByTimeAsync(0)
      expect(subscriptions).toHaveLength(count + 1)
      releaseHeld()
      stopHeld()
      expect(subscription(count).unsubscribe).not.toHaveBeenCalled()
      releaseReplacement()
      stopReplacement()
      expect(subscription(count).unsubscribe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(subscriptions).toHaveLength(count + 1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
